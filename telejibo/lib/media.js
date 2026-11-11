// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Robot devices for a call: the live microphone, MediaOut playback,
// and the camera (its live stream, or preview photos decoded to I420). Media flows over the helper's
// private pipes (fd 3 microphone in, 4 audio out, 5 camera in, 6 video out; HELPER.md).
var events = require('events'), childProcess = require('child_process');
var createLog = require('./log'), PhotoCamera = require('./photo-camera'), PageMicrophone = require('./microphone'), CallCamera = require('./camera'), SelfView = require('./self-view');
var CAMERA_FRAME = 12 + 320 * 240 * 3 / 2;
// Why a device fails is only knowable from these lines (the screen shows one message for
// every cause), so each stage of opening the devices says what it is doing and how long it took.
function why(error) { return error ? (error.code ? error.code + ': ' : '') + (error.message || String(error)) : 'unknown'; }
function queued(stream) { return typeof stream.writableLength === 'number' ? stream.writableLength : stream._writableState && stream._writableState.length || 0; }

var toI420 = require('./pixels');
// Camera input frame: `JICF`, little-endian uint32 width and height, then I420 (HELPER.md).
// The header lets the helper find the next whole frame after any partial one.
function cameraFrame(i420, width, height) {
    var header = Buffer.alloc(12);
    // Plain byte stores: the simulator's Buffer has no write(string, offset, encoding).
    header[0] = 0x4a; header[1] = 0x49; header[2] = 0x43; header[3] = 0x46;   // JICF
    header.writeUInt32LE(width, 4); header.writeUInt32LE(height, 8);
    return Buffer.concat([header, i420]);
}
function fromI420(bytes, width, height, rgba) {
    var size = width * height;
    for (var y = 0; y < height; ++y) for (var x = 0; x < width; ++x) {
        var c = bytes[y*width+x] - 16, at = y*width+x, uv = (y >> 1) * (width >> 1) + (x >> 1);
        var d = bytes[size+uv] - 128, e = bytes[size+size/4+uv] - 128;
        rgba[at*4] = (298*c + 409*e + 128) >> 8;
        rgba[at*4+1] = (298*c - 100*d - 208*e + 128) >> 8;
        rgba[at*4+2] = (298*c + 516*d + 128) >> 8; rgba[at*4+3] = 255;
    }
}
class VideoFrames {
    constructor(receive) { this.receive = receive; this.buffer = Buffer.alloc(0); }
    write(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (this.buffer.length > 1024 * 1024) throw Error('video_pipe_limit');
        while (this.buffer.length >= 12) {
            if (this.buffer.toString('ascii',0,4) !== 'JIVF') throw Error('video_pipe_header');
            var width = this.buffer.readUInt32LE(4), height = this.buffer.readUInt32LE(8);
            if (width < 2 || height < 2 || width > 640 || height > 480 || width % 2 || height % 2) throw Error('video_pipe_dimensions');
            var size = width * height * 3 / 2;
            if (this.buffer.length < 12 + size) return;
            this.receive(this.buffer.slice(12, 12 + size), width, height);
            this.buffer = this.buffer.slice(12 + size);
        }
    }
}

class RobotMedia extends events.EventEmitter {
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {}; this.children = []; this.closed = false;
        this.log = createLog(this.options.log, 'media');
        this.cameraTransition = Promise.resolve(); this.helper = null; this.canvas = null; this.listeners = [];
        this.callActive = false; this.cameraReady = false; this.cameraEnabled = false;
        this.began = 0; this.stopping = null;
        this.out = {sent: 0, skipped: 0, frames: 0}; this.outTimer = null;
        this.selfView = null; this.selfWanted = this.options.selfView === true;
    }
    // While the camera is on for a call, say every 3 s how many frames went to the helper: no
    // line at all means the camera was never switched on, zero sent means no decoded frame arrived or
    // the helper's pipe is full.
    outSummary() {
        var o = this.out, stream = this.helper && this.helper.stdio && this.helper.stdio[5];
        var live = this.cameraSource && this.cameraSource.summary && this.cameraSource.summary();
        if (live) { this.log.debug(live); return; }
        this.log.debug('camera out: ' + o.sent + ' frames sent, ' + o.skipped + ' skipped (helper pipe full), ' + o.frames +
            ' decoded frames, pipe queued ' + (stream ? queued(stream) : '?') + ' bytes');
        this.out = {sent: 0, skipped: 0, frames: 0};
    }
    since() { return Math.round(Date.now() - this.began) + 'ms'; }
    start(helper) {
        var self = this, spawn = this.options.spawn || childProcess.spawn, limit = this.options.timeoutMs || 20000;
        var note = this.log.info.bind(this.log);
        this.helper = helper; this.closed = false; this.stopping = null; this.listeners = []; this.abortStart = null;
        this.callActive = false; this.cameraReady = false; this.cameraEnabled = false;
        this.began = Date.now();
        if (this.jibo.privacyController && this.jibo.privacyController.enabled) return Promise.reject(Error('privacy_enabled'));
        note('start: helper pipes', helper.stdio ? helper.stdio.length : 'none', '(7 needed), device timeout', limit + 'ms');
        if (!helper.stdio || helper.stdio.length < 7) { this.log.error('FAILED media_pipes_unavailable: the helper was started without fd 3-6'); return Promise.reject(Error('media_pipes_unavailable')); }
        function listen(emitter, event, fn) { emitter.on(event, fn); self.listeners.push([emitter, event, fn]); }
        function within(name, ready) {
            return new Promise(function (resolve, reject) {
                note('waiting for the ' + name + ' (' + self.since() + ')');
                var timeout = setTimeout(function () {
                    self.abortStart = null;
                    self.log.error('FAILED ' + name + ': nothing after ' + self.since());
                    reject(Error(name + '_unavailable'));
                }, limit);
                // A device that fails or a stop() ends the wait at once, not after the timeout.
                self.abortStart = function (error) { clearTimeout(timeout); note('stopped waiting for the ' + name + ' (' + self.since() + '): ' + why(error)); reject(error); };
                ready(function () { clearTimeout(timeout); self.abortStart = null; note(name + ' ready after ' + self.since()); resolve(); });
            });
        }
        this.canvas = document.createElement('canvas'); this.canvas.width = 320; this.canvas.height = 240;
        var decoder = new VideoFrames(function (bytes,width,height) {
            if (self.closed) return;
            self.canvas.width = width; self.canvas.height = height;
            var ctx = self.canvas.getContext('2d'), pixels = ctx.createImageData(width,height);
            fromI420(bytes,width,height,pixels.data); ctx.putImageData(pixels,0,0); self.emit('video',self.canvas);
        });
        listen(helper.stdio[6], 'data', function (bytes) { try { decoder.write(bytes); } catch (error) { self.fail('video pipe from the helper: ' + why(error)); } });
        [3,4,5,6].forEach(function (fd) { listen(helper.stdio[fd], 'error', function (error) { if (!self.closed) self.fail('helper pipe fd ' + fd + ': ' + why(error)); }); });
        // Without capture, fd 3 stays open and empty and the helper supplies silence.
        var capture = this.options.captureMicrophone !== false;
        if (!capture) note('microphone capture disabled; helper supplies silence');
        var speaker = spawn('gst-launch-1.0', ['-q','fdsrc','fd=0','blocksize=1920','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2','!','audioconvert','!','audioresample','!',
            'alsasink','device=MediaOut','sync=false'], {stdio:['pipe','ignore','pipe']});
        // Writes to a speaker that has just exited fail with EPIPE before its exit arrives.
        speaker.stdin.on('error',function (error) { if (!self.closed) self.fail('speaker pipe: ' + why(error)); });
        this.children = [speaker];
        [['speaker',speaker]].forEach(function (entry) {
            var name = entry[0], child = entry[1], said = '';
            note(name + ' pipeline started (pid ' + child.pid + ')');
            child.on('error',function (error) { if (!self.closed) self.fail(name + ' pipeline error: ' + why(error)); });
            child.on('exit',function (code, signal) {
                if (!self.closed) self.fail(name + ' pipeline exited (code ' + code + ', signal ' + signal + ')' + (said ? ', it said: ' + said.trim().slice(-300) : ''));
            });
            child.stderr.on('data',function (bytes) { if (said.length < 600) said += String(bytes); });
        });
        listen(helper.stdio[4], 'data', function (bytes) {
            // A stalled speaker drops decoded audio; device loss is reported by exit.
            if (!self.closed && queued(speaker.stdin) < 38400) speaker.stdin.write(bytes);
        });
        var Photo = this.options.camera || PhotoCamera;
        this.cameraSource = new CallCamera(this.jibo, {destination: helper.stdio[5], log: this.log, stream: this.options.cameraStream,
            photo: new Photo(this.jibo, {spawn: spawn, log: this.log, timeoutMs: limit})});
        this.cameraSource.on('failure', function (error) { if (!self.closed) self.fail('camera: ' + why(error)); });
        this.cameraSource.on('stream', function (bytes, id) { if (self.selfView && self.sendingVideo()) self.selfView.stream(bytes, id); });
        this.cameraSource.on('frame', function (bytes) {
            if (self.closed) return;
            if (self.jibo.privacyController && self.jibo.privacyController.enabled) { self.fail('privacy_enabled'); return; }
            self.out.frames++;
            if (self.sendingVideo()) {
                var stream = helper.stdio[5];
                if (queued(stream) < CAMERA_FRAME) { stream.write(cameraFrame(bytes,320,240)); self.out.sent++; }
                else self.out.skipped++;
            }
            if (self.selfView && self.sendingVideo()) self.selfView.frame(bytes, 320, 240, fromI420);
            self.cameraReady = true;
        });
        // One device at a time: a successful request is not a decoded frame.
        var microphoneReady = capture ? within('microphone', function (done) {
            try {
                var Microphone = self.options.microphone || PageMicrophone;
                // Audio leaves Jibo only while a call is up.
                self.microphoneSource = new Microphone(self.jibo, {log: self.log, active: function () { return !self.closed && self.callActive; }});
                self.microphoneSource.on('failure', function (error) { if (!self.closed) self.fail('microphone: ' + why(error)); });
                self.microphoneSource.start(helper.stdio[3]).then(done, function (error) {
                    if (!self.closed) self.fail('microphone preparation: ' + why(error));
                });
            } catch (error) { self.fail('microphone preparation: ' + why(error)); }
        }) : Promise.resolve();
        return microphoneReady.then(function () {
            if (self.closed) throw Error('media_closed');
            if (self.jibo.privacyController && self.jibo.privacyController.enabled) throw Error('privacy_enabled');
            return within('camera', function (done) {
                // Probe and release before declaring media ready. Enabling the call's
                // camera starts fresh capture; camera-off cancels preview requests.
                self.cameraSource.probe().then(done, function (error) {
                    if (!self.closed) self.fail('camera preparation: ' + why(error));
                });
            });
        }).then(function () {
            if (self.closed) throw Error('media_closed'); return true;
        }).catch(function (error) { return self.stop().then(function () { throw error; }); });
    }
    sendingVideo() { return this.callActive && this.cameraEnabled; }
    // The small own-camera picture: on only while the camera is sending and the person wants it.
    setSelfView(wanted) { this.selfWanted = !!wanted; this.syncSelfView(); }
    syncSelfView() {
        var self = this, on = this.selfWanted && !this.closed && this.sendingVideo();
        if (on && !this.selfView) {
            var host = this.options.page || (typeof window !== 'undefined' ? window : null);
            if (!host || !host.document) return;
            this.selfView = new SelfView(host, function (canvas) { if (!self.closed) self.emit('self', canvas); });
        } else if (!on && this.selfView) {
            this.selfView.stop(); this.selfView = null; this.emit('self', null);
        }
    }
    setCallActive(active) {
        if (active !== this.callActive) this.log.info('call ' + (active ? (this.options.captureMicrophone === false ? 'active: microphone capture disabled' : 'active: the microphone now goes to the call') : 'no longer active') + ' (' + this.since() + ')');
        this.callActive = active; if (!active) this.setCamera(false);
        this.syncSelfView();
    }
    setCamera(enabled) {
        enabled = !!enabled;
        if (enabled && this.jibo.privacyController && this.jibo.privacyController.enabled) { this.fail('privacy_enabled'); return; }
        if (enabled !== this.cameraEnabled) this.log.info('camera ' + (enabled ? 'ON for the call' + (this.callActive ? '' : ' (but the call is not active yet, so nothing is sent)') : 'off'));
        this.cameraEnabled = enabled;
        this.syncSelfView();
        if (this.cameraSource) {
            var current = this;
            // Cancel an in-flight startup at once on camera-off. The queued work
            // reads the latest state so quick off/on/off taps cannot restart it late.
            var canceled = this.sendingVideo() ? Promise.resolve() : this.cameraSource.stop();
            this.cameraTransition = this.cameraTransition.catch(function () {}).then(function () { return canceled; }).then(function () {
                if (current.closed) return;
                return current.sendingVideo() ? current.cameraSource.start() : current.cameraSource.stop();
            }).catch(function (error) {
                if (!current.closed && error.message !== 'camera_closed') current.fail('camera transition: ' + why(error));
            });
        }
        if (this.outTimer !== null) { clearInterval(this.outTimer); this.outTimer = null; }
        if (enabled) { var self = this; this.out = {sent: 0, skipped: 0, frames: 0}; this.outTimer = setInterval(function () { self.outSummary(); }, 3000); }
    }
    // The helper needs a keyframe from the camera stream.
    restartCamera() { if (!this.closed && this.cameraSource && this.sendingVideo()) this.cameraSource.restart(); }
    fail(reason) {
        if (this.closed) return;
        this.log.error('device lost (' + this.since() + '): ' + (reason || 'no reason given'));
        var self = this, stopped = this.stop(Error('media_unavailable'));
        this.emit('unavailable');
        stopped.catch(function (error) { self.log.error('media cleanup failed: ' + why(error)); });
    }
    stop(reason) {
        if (this.stopping) return this.stopping;
        this.closed = true;
        var abort = this.abortStart; this.abortStart = null;
        if (abort) abort(reason || Error('media_closed'));
        if (this.outTimer !== null) clearInterval(this.outTimer); this.outTimer = null;
        if (this.selfView) { this.selfView.stop(); this.selfView = null; }
        (this.listeners || []).splice(0).forEach(function (l) { l[0].removeListener(l[1], l[2]); });
        var children = this.children.splice(0);
        var cameraStop = this.cameraSource ? this.cameraSource.stop() : Promise.resolve();
        var microphoneStop = this.microphoneSource ? this.microphoneSource.stop() : Promise.resolve();
        this.stopping = Promise.all([cameraStop,microphoneStop].concat(children.map(function (child) { return new Promise(function (resolve,reject) {
            if (child.exitCode !== null && child.exitCode !== undefined) return resolve();
            var timer = setTimeout(function () { child.kill('SIGKILL'); },1000);
            var deadline = setTimeout(function () { reject(Error('media_cleanup_timeout')); },2000);
            child.once('close',function () { clearTimeout(timer);clearTimeout(deadline); resolve(); });child.kill('SIGTERM');
        }); })));
        var self = this;
        this.stopping = this.stopping.catch(function (error) { self.stopping = null; throw error; });
        return this.stopping;
    }
}
module.exports = RobotMedia;
module.exports.VideoFrames = VideoFrames;
module.exports.toI420 = toI420;
module.exports.cameraFrame = cameraFrame;
module.exports.fromI420 = fromI420;
