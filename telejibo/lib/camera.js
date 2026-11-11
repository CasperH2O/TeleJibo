// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The call's camera. BEam 3.1.9's jibo.media.getCameraStream gives Jibo's camera as a live
// 1280x720 VP8 WebM stream from his hardware encoder (about 30 frames a second and 3 Mbit/s). Its bytes go to the helper as they
// are (HELPER.md, fd 5, `JIWM` records) and into the call without decoding or re-encoding
// on Jibo. If the stream cannot be had (older BEam, camera in use), decoded preview
// photos (photo-camera.js) are used instead. Nothing is stored.
// Runs on the robot's Node 6: ES2015 only.
var EventEmitter = require('events');

var PIECE = 262144;            // bytes per record; the helper accepts up to 1 MiB
var QUEUE_LIMIT = 1048576;     // about three seconds waiting in the helper's pipe: start over
var RESTART_GAP = 2000;        // ms between streams; each one costs the far side a short freeze
var serial = 0;
function queued(stream) { return typeof stream.writableLength === 'number' ? stream.writableLength : stream._writableState && stream._writableState.length || 0; }
function why(error) { return error ? (error.code ? error.code + ': ' : '') + (error.message || String(error)) : 'unknown'; }

// `JIWM`, then little-endian uint32 payload length, stream serial and piece index.
function record(stream, index, bytes) {
    var header = Buffer.alloc(16);
    header[0] = 0x4a; header[1] = 0x49; header[2] = 0x57; header[3] = 0x4d;   // JIWM
    header.writeUInt32LE(bytes.length, 4); header.writeUInt32LE(stream >>> 0, 8); header.writeUInt32LE(index >>> 0, 12);
    return Buffer.concat([header, bytes]);
}

class StreamCamera extends EventEmitter {
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {};
        this.destination = this.options.destination; this.log = this.options.log;
        this.generation = 0; this.running = false; this.starting = null; this.handle = null;
        this.deadline = null; this.watch = null; this.retry = null; this.again = null;
        this.startedAt = 0; this.lastData = 0;
        this.stats = {bytes: 0, streams: 0, restarts: 0};
    }
    static available(jibo) { return !!(jibo && jibo.media && typeof jibo.media.getCameraStream === 'function'); }
    isPrivate() { return !!(this.jibo.privacyController && this.jibo.privacyController.enabled); }
    // Resolves when the first bytes of a new stream have gone to the helper.
    start() {
        if (this.running) return this.starting;
        if (this.isPrivate()) return Promise.reject(Error('privacy_enabled'));
        var self = this, options = this.options, generation = ++this.generation, id = serial = (serial + 1) >>> 0 || 1, index = 0;
        this.running = true; this.startedAt = Date.now(); this.stats.streams++;
        this.starting = new Promise(function (resolve, reject) {
            var first = true, attempts = 0, dropped = false;
            function current() { return self.running && generation === self.generation; }
            function fail(error) {
                if (!current()) return;
                self.halt();
                if (first) { first = false; reject(error); } else self.emit('failure', error);
            }
            function data(bytes) {
                if (!current()) return;
                self.lastData = Date.now();
                // The stream cannot lose bytes and stay readable, so a full pipe means a new stream,
                // and nothing more of this one: later pieces would follow the gap unnoticed.
                if (dropped) return;
                if (queued(self.destination) > (options.queueLimit || QUEUE_LIMIT)) { dropped = true; self.restart('the helper is not reading'); return; }
                try {
                    for (var at = 0; at < bytes.length; at += PIECE) self.destination.write(record(id, index++, bytes.slice(at, at + PIECE)));
                } catch (error) { fail(error); return; }
                self.stats.bytes += bytes.length;
                self.emit('data', bytes, id);
                if (first) { first = false; clearTimeout(self.deadline); self.deadline = null; resolve(); }
            }
            function open() {
                self.retry = null;
                if (!current()) return;
                Promise.resolve().then(function () { return self.jibo.media.getCameraStream(data); }).then(function (handle) {
                    if (!current()) { try { handle.stop(); } catch (_) {} return; }
                    self.handle = handle; self.lastData = Date.now();
                    // BEam ends the stream by itself (privacy mode, the encoder stopping) without telling us.
                    // Until the first bytes the start-up deadline applies, not the stall check.
                    self.watch = setInterval(function () {
                        if (self.isPrivate()) fail(Error('privacy_enabled'));
                        else if (!first && Date.now() - self.lastData > (options.stallMs || 3000)) fail(Error('camera_stream_stalled'));
                    }, 500);
                }, function (error) {
                    // The previous stream is still closing: BEam frees the camera a moment after stop().
                    if (current() && /in use/i.test(error && error.message || '') && ++attempts < 12) { self.retry = setTimeout(open, 300); return; }
                    fail(error instanceof Error ? error : Error('camera_stream_refused'));
                });
            }
            self.deadline = setTimeout(function () { fail(Error('camera_stream_no_data')); }, options.timeoutMs || 10000);
            open();
        });
        // A stop during start is not an error for whoever asked to stop.
        this.starting.catch(function () {});
        return this.starting;
    }
    // A new stream, which starts with its header and a keyframe. Streams are at least RESTART_GAP apart.
    restart(reason) {
        var self = this;
        if (!this.running || this.again) return;
        var wait = Math.max(0, this.startedAt + (this.options.restartGap === undefined ? RESTART_GAP : this.options.restartGap) - Date.now());
        this.again = setTimeout(function () {
            self.again = null;
            if (!self.running) return;
            if (self.log) self.log.info('camera stream: starting a new one (' + reason + ')');
            self.stats.restarts++;
            self.halt();
            self.start().catch(function (error) { self.emit('failure', error); });
        }, wait);
    }
    halt() {
        this.generation++; this.running = false; this.starting = null;
        clearTimeout(this.deadline); clearInterval(this.watch); clearTimeout(this.retry); clearTimeout(this.again);
        this.deadline = this.watch = this.retry = this.again = null;
        var handle = this.handle; this.handle = null;
        if (handle) try { handle.stop(); } catch (_) {}
    }
    stop() { this.halt(); return Promise.resolve(); }
}

// The stream when Jibo has it, preview photos when he does not. Emits `frame` (I420 from
// the photo path, for the caller to send) and `failure` when neither works.
class CallCamera extends EventEmitter {
    // options.destination: the helper's camera pipe. options.photo: the photo camera to fall back on.
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {}; this.log = this.options.log;
        var self = this;
        this.photo = this.options.photo;
        this.photo.on('frame', function (bytes) { if (self.mode === 'photo') self.emit('frame', bytes); });
        this.photo.on('failure', function (error) { if (self.mode === 'photo') self.emit('failure', error); });
        this.stream = null; this.mode = 'photo'; this.wanted = false;
        if (this.options.stream !== false && StreamCamera.available(jibo)) {
            this.stream = new StreamCamera(jibo, {destination: this.options.destination, log: this.log, timeoutMs: this.options.streamTimeoutMs,
                stallMs: this.options.stallMs, restartGap: this.options.restartGap, queueLimit: this.options.queueLimit});
            this.stream.on('failure', function (error) { self.fallBack(error); });
            // The same bytes, for the self-view.
            this.stream.on('data', function (bytes, id) { self.emit('stream', bytes, id); });
            this.mode = 'stream';
        }
    }
    note(text) { if (this.log) this.log.info(text); }
    // Before a call: is there a camera at all? The stream needs no trial; photos take one.
    probe() {
        var photo = this.photo;
        if (this.mode === 'stream') return Promise.resolve();
        return photo.start().then(function () { return photo.stop(); });
    }
    start() {
        var self = this;
        this.wanted = true;
        if (this.mode !== 'stream') return this.photo.start();
        return this.stream.start().then(function () {
            self.note('camera: live 720p stream from Jibo\'s encoder, sent as it is');
        }, function (error) {
            if (!self.wanted) return;
            return self.fallBack(error);
        });
    }
    // The stream is gone for this call; privacy mode ends the camera altogether.
    fallBack(error) {
        var self = this;
        if (this.mode !== 'stream') return Promise.resolve();
        if (error && error.message === 'privacy_enabled') { this.emit('failure', error); return Promise.resolve(); }
        this.mode = 'photo'; this.stream.halt();
        if (this.log) this.log.warn('camera: no live stream (' + why(error) + '); using preview photos instead');
        if (!this.wanted) return Promise.resolve();
        return this.photo.start().catch(function (failure) { self.emit('failure', failure); });
    }
    // The helper cannot use the stream any more (a piece went missing, or no keyframe came).
    restart(reason) { if (this.mode === 'stream' && this.wanted) this.stream.restart(reason || 'the helper asked for a new stream'); }
    stop() {
        this.wanted = false;
        return Promise.all([this.stream ? this.stream.stop() : null, this.photo.stop()]);
    }
    summary() {
        if (this.mode !== 'stream') return null;
        var s = this.stream.stats, text = 'camera stream: ' + Math.round(s.bytes / 1024) + ' KiB sent, ' + s.streams + ' streams, ' + s.restarts +
            ' restarts, pipe queued ' + queued(this.options.destination) + ' bytes';
        s.bytes = 0;
        return text;
    }
}

module.exports = CallCamera;
module.exports.StreamCamera = StreamCamera;
module.exports.record = record;
module.exports.PIECE = PIECE;
