// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Candidate adapter for the existing local processed-audio service. No ALSA open,
// recording, service start, mixer change, or global listening-mode change.
var EventEmitter = require('events'), http = require('http');
function queued(stream) { return typeof stream.writableLength === 'number' ? stream.writableLength : stream._writableState && stream._writableState.length || 0; }
function speechPlane(data) {
    var bytes;
    if (Buffer.isBuffer(data)) bytes = data;
    else if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') bytes = Buffer.from(new Uint8Array(data));
    else throw Error('microphone_message_not_binary');
    // Two S16LE planes, each at most 100 ms at 16 kHz. WebSocket message
    // boundaries, rather than TCP chunks, delimit the pair of planes.
    if (!bytes.length || bytes.length % 4 || bytes.length > 6400) throw Error('microphone_message_size_' + bytes.length);
    return bytes.slice(0,bytes.length / 2);
}
function captureMuted(mixer) {
    var muted = false;
    ['master','media'].forEach(function (name) {
        var value = mixer && mixer[name];
        if (!value || typeof value.mute !== 'boolean' || typeof value.recordVolume !== 'number' ||
            !isFinite(value.recordVolume) || value.recordVolume < 0 || value.recordVolume > 1)
            throw Error('microphone_mixer_state');
        if (value.mute || value.recordVolume === 0) muted = true;
    });
    return muted;
}
class SocketMicrophone extends EventEmitter {
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {};
        var records = jibo.records || [], record = records.filter(function (r) { return r.name === 'audio'; })[0];
        var port = record ? Number(record.port) : 8383;
        if (!isFinite(port) || port < 1 || port > 65535 || Math.floor(port) !== port) throw Error('microphone_service_address');
        // Audio is an on-robot service. Use its registered port on loopback.
        this.url = 'ws://127.0.0.1:' + port + '/sout';
        this.socket = null; this.closed = true; this.stopping = null; this.port = port;
        this.mixerTimer = null; this.mixerRequest = null; this.captureState = null; this.stateAt = 0;
        this.deadline = null; this.stall = null; this.cancelStart = null;
        this.received = 0; this.dropped = 0; this.generation = 0;
    }
    isPrivate() { return !!(this.jibo.privacyController && this.jibo.privacyController.enabled); }
    readMixer() {
        if (this.options.readMixer) return this.options.readMixer();
        var self = this;
        return new Promise(function (resolve,reject) {
            var body = '', settled = false, timer;
            function finish(error, value) {
                if (settled) return; settled = true; clearTimeout(timer);
                if (self.mixerRequest === request) self.mixerRequest = null;
                if (error) reject(error); else resolve(value);
            }
            var request = self.mixerRequest = http.get({hostname:'127.0.0.1',port:self.port,path:'/mixer'},function (response) {
                if (response.statusCode !== 200) { response.resume(); finish(Error('microphone_mixer_http_' + response.statusCode)); return; }
                response.on('data',function (bytes) {
                    body += String(bytes);
                    if (body.length > 16384) { finish(Error('microphone_mixer_size')); request.abort(); }
                });
                response.on('error',function (error) { finish(error); });
                response.on('end',function () {
                    try { finish(null,JSON.parse(body)); } catch (_) { finish(Error('microphone_mixer_json')); }
                });
            });
            request.on('error',function (error) { finish(error); });
            timer = setTimeout(function () { finish(Error('microphone_mixer_timeout')); request.abort(); },1000);
        });
    }
    start(destination) {
        var self = this;
        if (!this.closed || this.socket) return Promise.reject(Error('microphone_already_started'));
        if (this.isPrivate()) return Promise.reject(Error('microphone_privacy'));
        this.closed = false; this.stopping = null; this.received = 0; this.dropped = 0;
        var generation = ++this.generation; this.captureState = null; this.stateAt = 0;
        return new Promise(function (resolve,reject) {
            var ready = false, failed = false;
            function fail(error) {
                if (self.closed || failed || generation !== self.generation) return;
                failed = true; clearTimeout(self.deadline); clearTimeout(self.stall);
                self.cancelStart = null;
                if (!ready) reject(error);
                self.stop().catch(function (cleanup) { if (self.options.log) self.options.log.warn('microphone cleanup failed: ' + cleanup.message); });
                self.emit('failure', error);
            }
            function pollMixer() {
                if (self.closed || generation !== self.generation) return;
                Promise.resolve().then(function () {
                    if (self.closed || generation !== self.generation) return null;
                    return self.readMixer();
                }).then(function (mixer) {
                    if (self.closed || generation !== self.generation) return;
                    try {
                        var muted = captureMuted(mixer);
                        if (self.options.log && (!self.captureState || self.captureState.muted !== muted))
                            self.options.log.info('microphone capture ' + (muted ? 'muted by existing system controls' : 'enabled by existing system controls'));
                        self.captureState = {muted:muted}; self.stateAt = Date.now();
                        self.mixerTimer = setTimeout(pollMixer,250);
                    } catch (error) { fail(error); }
                },fail);
            }
            pollMixer();
            self.cancelStart = function () { if (!ready) reject(Error('microphone_closed')); self.cancelStart = null; };
            self.deadline = setTimeout(function () { fail(Error('microphone_no_frames')); }, self.options.timeoutMs || 5000);
            try {
                var Socket = self.options.WebSocket || (typeof window !== 'undefined' && window.WebSocket);
                if (!Socket) throw Error('microphone_websocket_unavailable');
                var socket = self.socket = new Socket(self.url);
                socket.binaryType = 'arraybuffer';
                socket.onopen = function () {
                    if (self.closed || self.socket !== socket) return;
                    if (self.options.log) self.options.log.info('microphone service connected: ' + self.url + '; waiting for PCM');
                };
                socket.onmessage = function (event) {
                    if (self.closed || failed || self.socket !== socket) return;
                    if (self.isPrivate()) return fail(Error('microphone_privacy'));
                    var speech;
                    try { speech = speechPlane(event.data); }
                    catch (error) { fail(error); return; }
                    clearTimeout(self.stall);
                    self.stall = setTimeout(function () { fail(Error('microphone_stalled')); }, self.options.stallMs || 5000);
                    self.received++;
                    // This feed precedes soft-volume routing. Until current capture
                    // controls are known, drain without forwarding. A mute or stale
                    // state supplies silence, preserving the converter's PCM clock.
                    if (!self.captureState) return;
                    if (self.captureState.muted || Date.now() - self.stateAt > 750) speech = Buffer.alloc(speech.length);
                    // Keep draining the service regardless of downstream congestion.
                    // Each dropped unit is a whole mono block, preserving PCM alignment.
                    try {
                        if (queued(destination) + speech.length <= 3200) destination.write(speech);
                        else self.dropped++;
                    } catch (error) { fail(error); return; }
                    if (!ready) {
                        ready = true; clearTimeout(self.deadline); self.cancelStart = null;
                        if (self.options.log) self.options.log.info('microphone service: first planar PCM message (' + speech.length * 2 + ' bytes), speech mono S16LE 16000 Hz');
                        resolve();
                    }
                };
                socket.onerror = function () { fail(Error('microphone_socket_error')); };
                socket.onclose = function () { fail(Error('microphone_socket_closed')); };
            } catch (error) { fail(error); }
        });
    }
    stop() {
        var self = this; this.closed = true;
        clearTimeout(this.deadline); clearTimeout(this.stall); clearTimeout(this.mixerTimer);
        if (this.mixerRequest) { this.mixerRequest.abort(); this.mixerRequest = null; }
        if (this.cancelStart) this.cancelStart();
        if (this.stopping) return this.stopping;
        var socket = this.socket;
        if (!socket) return Promise.resolve();
        this.stopping = new Promise(function (resolve,reject) {
            var deadline, settled = false;
            function done(error) {
                if (settled) return; settled = true;
                clearTimeout(deadline);
                socket.onopen = socket.onmessage = socket.onclose = null;
                socket.onerror = function () {};
                if (error) reject(error);
                else { if (self.socket === socket) self.socket = null; resolve(); }
            }
            // Stop forwarding synchronously before requesting the close handshake.
            socket.onmessage = socket.onopen = null;
            socket.onerror = function () {};
            socket.onclose = function () { done(); };
            if (socket.readyState === 3) return done();
            deadline = setTimeout(function () { done(Error('microphone_cleanup_timeout')); }, 2000);
            try { socket.close(); } catch (error) { done(error); }
        }).then(function () { self.stopping = null; },function (error) { self.stopping = null; throw error; });
        return this.stopping;
    }
}
module.exports = SocketMicrophone;
module.exports.speechPlane = speechPlane;
module.exports.captureMuted = captureMuted;
