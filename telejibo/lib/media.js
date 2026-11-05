// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Robot devices for a call, held only while one runs: the microphone (ALSA MediaIn) and
// speaker (ALSA MediaOut) through gst-launch, as BEam's own players do, and the camera
// through the LPS media service's photographer preview. Media flows over the helper's
// private pipes (fd 3 microphone in, 4 audio out, 5 camera in, 6 video out; HELPER.md).
var events = require('events'), childProcess = require('child_process');
var CAMERA_FRAME = 12 + 320 * 240 * 3 / 2;
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
    header.write('JICF', 0, 'ascii'); header.writeUInt32LE(width, 4); header.writeUInt32LE(height, 8);
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
        this.timer = null; this.pending = false; this.helper = null; this.canvas = null; this.listeners = [];
        this.callActive = false; this.cameraReady = false; this.cameraEnabled = false;
    }
    start(helper) {
        var self = this, spawn = this.options.spawn || childProcess.spawn, limit = this.options.timeoutMs || 20000;
        this.helper = helper; this.closed = false; this.pending = false; this.listeners = []; this.abortStart = null;
        this.callActive = false; this.cameraReady = false; this.cameraEnabled = false;
        if (!helper.stdio || helper.stdio.length < 7) return Promise.reject(Error('media_pipes_unavailable'));
        function listen(emitter, event, fn) { emitter.on(event, fn); self.listeners.push([emitter, event, fn]); }
        function within(name, ready) {
            return new Promise(function (resolve, reject) {
                var timeout = setTimeout(function () { self.abortStart = null; reject(Error(name + '_unavailable')); }, limit);
                // A device that fails or a stop() ends the wait at once, not after the timeout.
                self.abortStart = function (error) { clearTimeout(timeout); reject(error); };
                ready(function () { clearTimeout(timeout); self.abortStart = null; resolve(); });
            });
        }
        this.capture = document.createElement('canvas'); this.capture.width = 320; this.capture.height = 240;
        this.canvas = document.createElement('canvas'); this.canvas.width = 320; this.canvas.height = 240;
        var decoder = new VideoFrames(function (bytes,width,height) {
            if (self.closed) return;
            self.canvas.width = width; self.canvas.height = height;
            var ctx = self.canvas.getContext('2d'), pixels = ctx.createImageData(width,height);
            fromI420(bytes,width,height,pixels.data); ctx.putImageData(pixels,0,0); self.emit('video',self.canvas);
        });
        listen(helper.stdio[6], 'data', function (bytes) { try { decoder.write(bytes); } catch (_) { self.fail(); } });
        for (var fd = 3; fd <= 6; ++fd) listen(helper.stdio[fd], 'error', function () { if (!self.closed) self.fail(); });
        var microphone = spawn('gst-launch-1.0', ['-q','alsasrc','device=MediaIn','!','audioconvert','!','audioresample','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2','!','fdsink','fd=1','sync=false'],
            {stdio:['ignore','pipe','pipe']});
        var speaker = spawn('gst-launch-1.0', ['-q','fdsrc','fd=0','blocksize=1920','!',
            'audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=2','!','audioconvert','!','audioresample','!',
            'alsasink','device=MediaOut','sync=false'], {stdio:['pipe','ignore','pipe']});
        // Writes to a speaker that has just exited fail with EPIPE before its exit arrives.
        speaker.stdin.on('error',function () { if (!self.closed) self.fail(); });
        this.children = [microphone,speaker];
        this.children.forEach(function (child) {
            child.on('error',function () { if (!self.closed) self.fail(); });
            child.on('exit',function () { if (!self.closed) self.fail(); });
            child.stderr.on('data',function () {});
        });
        microphone.stdout.on('data',function (bytes) {
            var input = helper.stdio[3];
            if (!self.closed && self.callActive && queued(input) < 38400) input.write(bytes);
        });
        listen(helper.stdio[4], 'data', function (bytes) {
            // A stalled speaker drops decoded audio; device loss is reported by exit.
            if (!self.closed && queued(speaker.stdin) < 38400) speaker.stdin.write(bytes);
        });
        // One device at a time: concurrent first opens can queue behind each other.
        return within('microphone', function (done) { microphone.stdout.once('data', done); }).then(function () {
            if (self.closed) throw Error('media_closed');
            self.timer = setInterval(function () { self.cameraFrame(); },100);
            return within('camera', function (done) { self.once('camera-ready', done); });
        }).then(function () {
            if (self.closed) throw Error('media_closed'); return true;
        }).catch(function (error) { return self.stop().then(function () { throw error; }); });
    }
    cameraFrame() {
        // Probe once for readiness, then capture only while this call's camera is on.
        if (this.closed || this.pending || this.cameraReady && !this.sendingVideo()) return;
        var self = this; this.pending = true;
        try {
            this.jibo.media.takePhoto({photoType:this.jibo.media.PhotoType.PREVIEW,flip:false,undistort:true},function (error,photo) {
                if (error || self.closed) { self.pending = false; return; }
                self.jibo.loader.load({src:photo.url,format:'binary'},function (error,bytes) {
                    if (error || self.closed) { self.pending = false; return; }
                    var url = URL.createObjectURL(new Blob([bytes],{type:'image/jpeg'})),image = new Image();
                    image.onerror = function () { URL.revokeObjectURL(url); self.pending = false; };
                    image.onload = function () {
                        URL.revokeObjectURL(url); self.pending = false;
                        if (self.closed) return;
                        var ctx = self.capture.getContext('2d'); ctx.drawImage(image,0,0,320,240);
                        var stream = self.helper.stdio[5];
                        if (self.sendingVideo() && queued(stream) < CAMERA_FRAME) stream.write(cameraFrame(toI420(ctx.getImageData(0,0,320,240).data,320,240),320,240));
                        self.cameraReady = true;
                        self.emit('camera-ready');
                    };image.src = url;
                });
            });
        } catch (_) { this.pending = false; }
    }
    sendingVideo() { return this.callActive && this.cameraEnabled; }
    setCallActive(active) { this.callActive = active; if (!active) this.cameraEnabled = false; }
    setCamera(enabled) { this.cameraEnabled = !!enabled; }
    fail() { if (this.closed) return; this.emit('unavailable'); this.stop(Error('media_unavailable')); }
    stop(reason) {
        this.closed = true;
        var abort = this.abortStart; this.abortStart = null;
        if (abort) abort(reason || Error('media_closed'));
        if (this.timer !== null) clearInterval(this.timer); this.timer = null;
        (this.listeners || []).splice(0).forEach(function (l) { l[0].removeListener(l[1], l[2]); });
        var children = this.children.splice(0);
        return Promise.all(children.map(function (child) { return new Promise(function (resolve,reject) {
            if (child.exitCode !== null && child.exitCode !== undefined) return resolve();
            var timer = setTimeout(function () { child.kill('SIGKILL'); },1000);
            var deadline = setTimeout(function () { reject(Error('media_cleanup_timeout')); },2000);
            child.once('close',function () { clearTimeout(timer);clearTimeout(deadline); resolve(); });child.kill('SIGTERM');
        }); }));
    }
}
module.exports = RobotMedia;
module.exports.VideoFrames = VideoFrames;
module.exports.toI420 = toI420;
module.exports.cameraFrame = cameraFrame;
module.exports.fromI420 = fromI420;
