// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The small picture of what Jibo's camera sends. The call's video leaves Jibo without
// being decoded, so this is the one place that decodes it: the same WebM bytes go to a
// <video> through MediaSource, and a few times a second its picture is drawn, mirrored,
// onto a small canvas for the face. With the photo fallback the frames are already
// decoded and are drawn directly. Decoding costs processor time; the person can switch
// the picture off. Nothing is stored.
// Runs on the robot's Chrome 53: ES2015 only.
var WIDTH = 208, HEIGHT = 117;       // 16:9 tile
var PAINT_MS = 125;                  // 8 pictures a second is plenty for a thumbnail
var QUEUE_LIMIT = 4 * 1024 * 1024;   // bytes waiting for the decoder before starting over
var MIME = 'video/webm; codecs="vp8"';

class SelfView {
    // host: {document, MediaSource, URL} (the page's); onPaint(canvas) after each new picture.
    constructor(host, onPaint) {
        this.host = host; this.onPaint = onPaint;
        this.canvas = host.document.createElement('canvas'); this.canvas.width = WIDTH; this.canvas.height = HEIGHT;
        this.video = null; this.source = null; this.buffer = null; this.url = null; this.queue = []; this.queued = 0;
        this.serial = null; this.timer = null; this.raw = null; this.rawCanvas = null; this.closed = false;
    }
    static supported(host) {
        return !!(host && host.document && host.MediaSource && host.URL && (!host.MediaSource.isTypeSupported || host.MediaSource.isTypeSupported(MIME)));
    }
    // A piece of the camera's live stream; a new serial is a new stream with its own header.
    stream(bytes, serial) {
        if (this.closed || !SelfView.supported(this.host)) return;
        if (serial !== this.serial || this.queued > QUEUE_LIMIT) { this.reset(); this.serial = serial; this.open(); }
        // The camera reuses its buffers: keep a copy.
        var copy = new Uint8Array(bytes.length); copy.set(bytes);
        this.queue.push(copy); this.queued += copy.length;
        this.pump();
    }
    open() {
        var self = this, host = this.host, source = this.source = new host.MediaSource();
        var video = this.video = host.document.createElement('video');
        video.muted = true; video.autoplay = true;
        this.url = host.URL.createObjectURL(source); video.src = this.url;
        source.addEventListener('sourceopen', function () {
            if (self.source !== source) return;
            try {
                var buffer = self.buffer = source.addSourceBuffer(MIME);
                buffer.mode = 'sequence';
                buffer.addEventListener('updateend', function () { self.pump(); });
            } catch (_) { self.reset(); return; }
            self.pump();
        });
        if (!this.timer) this.timer = setInterval(function () { self.paint(); }, PAINT_MS);
    }
    pump() {
        var buffer = this.buffer, video = this.video;
        if (!buffer || buffer.updating || !this.queue.length) return;
        try {
            var ranges = video.buffered;
            if (ranges.length) {
                var end = ranges.end(ranges.length - 1), start = ranges.start(0);
                // Stay with the live picture, and let go of what has been shown.
                if (end - video.currentTime > 0.5) video.currentTime = end - 0.1;
                if (end - start > 8) { buffer.remove(start, end - 4); return; }
            }
            var next = this.queue.shift(); this.queued -= next.length;
            buffer.appendBuffer(next);
            if (video.paused && video.play) { var playing = video.play(); if (playing && playing.catch) playing.catch(function () {}); }
        } catch (_) { this.reset(); }
    }
    // A decoded 4:3 preview frame (I420), from the photo fallback.
    frame(i420, width, height, fromI420) {
        if (this.closed) return;
        if (!this.rawCanvas) { this.rawCanvas = this.host.document.createElement('canvas'); }
        var raw = this.rawCanvas;
        if (raw.width !== width || raw.height !== height) { raw.width = width; raw.height = height; }
        var context = raw.getContext('2d'), pixels = context.createImageData(width, height);
        fromI420(i420, width, height, pixels.data); context.putImageData(pixels, 0, 0);
        this.draw(raw, width, height);
    }
    paint() {
        var video = this.video;
        if (!video || video.readyState < 2 || !video.videoWidth) return;
        this.draw(video, video.videoWidth, video.videoHeight);
    }
    // Fill the tile (centred crop), mirrored like a mirror.
    draw(image, width, height) {
        var context = this.canvas.getContext('2d'), scale = Math.max(WIDTH / width, HEIGHT / height);
        var w = WIDTH / scale, h = HEIGHT / scale;
        context.save(); context.translate(WIDTH, 0); context.scale(-1, 1);
        context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h, 0, 0, WIDTH, HEIGHT);
        context.restore();
        if (this.onPaint) this.onPaint(this.canvas);
    }
    reset() {
        var video = this.video, source = this.source;
        this.video = this.source = this.buffer = null; this.queue = []; this.queued = 0; this.serial = null;
        if (video) { try { video.pause(); video.removeAttribute('src'); video.load(); } catch (_) {} }
        if (source && source.readyState === 'open') try { source.endOfStream(); } catch (_) {}
        if (this.url) { try { this.host.URL.revokeObjectURL(this.url); } catch (_) {} this.url = null; }
    }
    stop() {
        this.closed = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        this.reset();
    }
}
module.exports = SelfView;
module.exports.WIDTH = WIDTH; module.exports.HEIGHT = HEIGHT;
