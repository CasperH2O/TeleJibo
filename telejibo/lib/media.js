// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Robot devices for a call, held only while one runs: the microphone (the local audio service) and
// speaker (ALSA MediaOut) and microphone conversion through gst-launch, and the camera through the native media service's continuous VP8/WebM stream. Media flows over the helper's
// private pipes (fd 3 microphone in, 4 audio out, 5 camera in, 6 video out; HELPER.md).
var events = require('events'), childProcess = require('child_process');
var createLog = require('./log'), NativeCamera = require('./camera'), SocketMicrophone = require('./microphone');
var CAMERA_FRAME = 12 + 320 * 240 * 3 / 2;
// Why a device fails is only knowable from these lines (the screen shows one message for
// every cause), so each stage of opening the devices says what it is doing and how long it took.
function why(error) { return error ? (error.code ? error.code + ': ' : '') + (error.message || String(error)) : 'unknown'; }
function queued(stream) { return typeof stream.writableLength === 'number' ? stream.writableLength : stream._writableState && stream._writableState.length || 0; }

function toI420(rgba, width, height) {
    var size = width * height, bytes = Buffer.alloc(size * 3 / 2);
    for (var y = 0; y < height; ++y) for (var x = 0; x < width; ++x) {
        var at = (y * width + x) * 4, r = rgba[at], g = rgba[at + 1], b = rgba[at + 2];
        bytes[y * width + x] = Math.max(16, Math.min(235, ((66*r + 129*g + 25*b + 128) >> 8) + 16));
        if (!(x & 1) && !(y & 1)) {
            var red = 0, green = 0, blue = 0;
            for (var row = 0; row < 2; ++row) for (var col = 0; col < 2; ++col) {
                var p = ((y + row) * width + x + col) * 4; red += rgba[p]; green += rgba[p+1]; blue += rgba[p+2];
            }
            red /= 4; green /= 4; blue /= 4;
            var uv = y / 2 * (width / 2) + x / 2;
            bytes[size + uv] = Math.max(16, Math.min(240, ((-38*red - 74*green + 112*blue + 128) >> 8) + 128));
            bytes[size + size / 4 + uv] = Math.max(16, Math.min(240, ((112*red - 94*green - 18*blue + 128) >> 8) + 128));
        }
    }
    return bytes;
}
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
    }
    // While the camera is on for a call, say every 3 s how many frames went to the helper: no
    // line at all means the camera was never switched on, zero sent means no decoded frame arrived or
    // the helper's pipe is full.
    outSummary() {
        var o = this.out, stream = this.helper && this.helper.stdio && this.helper.stdio[5];
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
        var microphone = spawn('gst-launch-1.0', ['-q','fdsrc','fd=0','blocksize=320','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=16000,channels=1','!','audioconvert','!','audioresample','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2','!','fdsink','fd=1','sync=false'],
            {stdio:['pipe','pipe','pipe']});
        note('microphone source: local processed-audio socket, mono S16LE 16000 Hz; helper input: stereo S16LE 48000 Hz');
        microphone.stdin.on('error',function (error) { if (!self.closed) self.fail('microphone converter pipe: ' + why(error)); });
        var speaker = spawn('gst-launch-1.0', ['-q','fdsrc','fd=0','blocksize=1920','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2','!','audioconvert','!','audioresample','!',
            'alsasink','device=MediaOut','sync=false'], {stdio:['pipe','ignore','pipe']});
        // Writes to a speaker that has just exited fail with EPIPE before its exit arrives.
        speaker.stdin.on('error',function (error) { if (!self.closed) self.fail('speaker pipe: ' + why(error)); });
        this.children = [microphone,speaker];
        [['microphone',microphone],['speaker',speaker]].forEach(function (entry) {
            var name = entry[0], child = entry[1], said = '';
            note(name + ' pipeline started (pid ' + child.pid + ')');
            child.on('error',function (error) { if (!self.closed) self.fail(name + ' pipeline error: ' + why(error)); });
            child.on('exit',function (code, signal) {
                if (!self.closed) self.fail(name + ' pipeline exited (code ' + code + ', signal ' + signal + ')' + (said ? ', it said: ' + said.trim().slice(-300) : ''));
            });
            child.stderr.on('data',function (bytes) { if (said.length < 600) said += String(bytes); });
        });
        var micBytes = 0;
        microphone.stdout.on('data',function (bytes) {
            if (!micBytes) note('microphone: first audio after ' + self.since());
            micBytes += bytes.length;
            var input = helper.stdio[3];
            if (!self.closed && self.callActive && queued(input) < 38400) input.write(bytes);
        });
        listen(helper.stdio[4], 'data', function (bytes) {
            // A stalled speaker drops decoded audio; device loss is reported by exit.
            if (!self.closed && queued(speaker.stdin) < 38400) speaker.stdin.write(bytes);
        });
        var Camera = this.options.camera || NativeCamera;
        this.cameraSource = new Camera(this.jibo, {spawn: spawn, log: this.log, timeoutMs: limit});
        this.cameraSource.on('failure', function (error) { if (!self.closed) self.fail('native camera: ' + why(error)); });
        this.cameraSource.on('frame', function (bytes) {
            if (self.closed) return;
            self.out.frames++;
            if (self.sendingVideo()) {
                var stream = helper.stdio[5];
                if (queued(stream) < CAMERA_FRAME) { stream.write(cameraFrame(bytes,320,240)); self.out.sent++; }
                else self.out.skipped++;
            }
            self.cameraReady = true;
        });
        // One device at a time: native startup is not evidence of a decoded frame.
        return within('microphone', function (done) {
            microphone.stdout.once('data', done);
            try {
                var Microphone = self.options.microphone || SocketMicrophone;
                self.microphoneSource = new Microphone(self.jibo, {log:self.log});
                self.microphoneSource.on('failure', function (error) { if (!self.closed) self.fail('microphone source: ' + why(error)); });
                self.microphoneSource.start(microphone.stdin).catch(function (error) {
                    if (!self.closed) self.fail('microphone preparation: ' + why(error));
                });
            } catch (error) { self.fail('microphone preparation: ' + why(error)); }
        }).then(function () {
            if (self.closed) throw Error('media_closed');
            return within('camera', function (done) {
                // Probe and release before declaring media ready. Enabling the call's
                // camera starts a fresh stream; camera-off keeps the sensor released.
                self.cameraSource.start().then(function () { return self.cameraSource.stop(); }).then(done, function (error) {
                    if (!self.closed) self.fail('camera preparation: ' + why(error));
                });
            });
        }).then(function () {
            if (self.closed) throw Error('media_closed'); return true;
        }).catch(function (error) { return self.stop().then(function () { throw error; }); });
    }
    sendingVideo() { return this.callActive && this.cameraEnabled; }
    setCallActive(active) {
        if (active !== this.callActive) this.log.info('call ' + (active ? 'active: the microphone now goes to the call' : 'no longer active') + ' (' + this.since() + ')');
        this.callActive = active; if (!active) this.setCamera(false);
    }
    setCamera(enabled) {
        enabled = !!enabled;
        if (enabled !== this.cameraEnabled) this.log.info('camera ' + (enabled ? 'ON for the call' + (this.callActive ? '' : ' (but the call is not active yet, so nothing is sent)') : 'off'));
        this.cameraEnabled = enabled;
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
