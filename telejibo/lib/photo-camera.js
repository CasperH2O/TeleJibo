// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Temporary PREVIEW photos, paced after decoding. No stored photos or native
// streaming session: every emitted I420 frame comes from a completed JPEG decode.
var events = require('events'), http = require('http'), toI420 = require('./pixels');
var createLog = require('./log');
function browser() {
    return {
        image: function () { return new Image(); },
        canvas: function () { return document.createElement('canvas'); },
        url: function (jpeg) { return URL.createObjectURL(new Blob([new Uint8Array(jpeg)], {type:'image/jpeg'})); },
        revoke: function (url) { URL.revokeObjectURL(url); }
    };
}
class PhotoCamera extends events.EventEmitter {
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {};
        this.log = createLog(this.options.log, 'preview camera');
        var record = (jibo.records || []).filter(function (r) { return r.name === 'media'; })[0];
        this.address = record ? {host:record.host === '0.0.0.0' ? '127.0.0.1' : record.host, port:Number(record.port)} : null;
        this.active = false; this.ready = false; this.generation = 0; this.starting = null;
        this.resolveReady = null; this.rejectReady = null; this.timer = null;
        this.cancelRequest = null; this.cancelDecode = null; this.canvas = null;
    }
    check(generation) {
        if (!this.active || generation !== this.generation) throw Error('camera_closed');
        if (this.jibo.privacyController && this.jibo.privacyController.enabled) throw Error('privacy_enabled');
    }
    start() {
        if (this.active) return this.starting || Promise.resolve();
        if (this.jibo.privacyController && this.jibo.privacyController.enabled) return Promise.reject(Error('privacy_enabled'));
        if (!this.address) return Promise.reject(Error('camera_media_service_missing'));
        var controller = this.jibo.cameraStreamController;
        if (controller && controller.state && controller.state !== 'off') return Promise.reject(Error('camera_busy'));
        this.active = true; this.ready = false;
        var self = this, generation = ++this.generation;
        this.starting = new Promise(function (resolve, reject) { self.resolveReady = resolve; self.rejectReady = reject; });
        var started = this.starting;
        this.log.info('start: temporary right-camera PREVIEW photos; 320x240 I420; at most 5 capture attempts/s');
        this.capture(generation);
        return started;
    }
    request(method, route, payload, maxBytes) {
        var self = this, address = this.address, send = this.options.request || http.request;
        return new Promise(function (resolve, reject) {
            var body = payload ? JSON.stringify(payload) : null, done = false, timer, request;
            function finish(error, bytes) {
                if (done) return; done = true; clearTimeout(timer);
                if (self.cancelRequest === cancel) self.cancelRequest = null;
                if (error) reject(error); else resolve(bytes);
            }
            function cancel(error) {
                finish(error || Error('camera_closed'));
                if (request) request.abort();
            }
            self.cancelRequest = cancel;
            request = send({hostname:address.host, port:address.port, method:method, path:route,
                headers:body ? {'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body)} : {}}, function (response) {
                if (done) { response.resume(); return; }
                if (response.statusCode !== 200) { cancel(Error('camera_http_' + response.statusCode)); return; }
                var chunks = [], size = 0;
                if (Number((response.headers || {})['content-length']) > maxBytes) { cancel(Error('camera_response_too_large')); return; }
                response.on('data', function (bytes) {
                    if (done) return;
                    size += bytes.length;
                    if (size > maxBytes) { cancel(Error('camera_response_too_large')); return; }
                    chunks.push(bytes);
                });
                response.on('error', function (error) { cancel(error); });
                response.on('aborted', function () { cancel(Error('camera_response_aborted')); });
                response.on('end', function () { finish(null, Buffer.concat(chunks)); });
                response.on('close', function () { if (!done) cancel(Error('camera_response_closed')); });
            });
            request.on('error', function (error) { finish(error); });
            timer = setTimeout(function () { cancel(Error('camera_http_timeout')); }, self.options.requestTimeoutMs || 4000);
            request.end(body || undefined);
        });
    }
    decode(jpeg, generation) {
        var self = this, api = this.options.browser || browser();
        return new Promise(function (resolve, reject) {
            var image = api.image(), url = api.url(jpeg), done = false;
            function finish(error, frame) {
                if (done) return; done = true; clearTimeout(timer);
                if (self.cancelDecode === cancel) self.cancelDecode = null;
                image.onload = image.onerror = null; image.src = ''; api.revoke(url);
                if (error) reject(error); else resolve(frame);
            }
            function cancel(error) { finish(error || Error('camera_closed')); }
            self.cancelDecode = cancel;
            var timer = setTimeout(function () { cancel(Error('camera_decode_timeout')); }, self.options.decodeTimeoutMs || 3000);
            image.onerror = function () { cancel(Error('camera_decode_failed')); };
            image.onload = function () {
                try {
                    self.check(generation);
                    var width = image.naturalWidth, height = image.naturalHeight;
                    if (!(width > 0 && height > 0) || width * height > 16 * 1024 * 1024) throw Error('camera_invalid_dimensions');
                    var canvas = self.canvas || (self.canvas = api.canvas()); canvas.width = 320; canvas.height = 240;
                    var context = canvas.getContext('2d'), scale = Math.min(320 / width, 240 / height);
                    context.fillStyle = '#000'; context.fillRect(0,0,320,240);
                    context.drawImage(image,(320-width*scale)/2,(240-height*scale)/2,width*scale,height*scale);
                    var pixels = context.getImageData(0,0,320,240).data;
                    if (pixels.length !== 320 * 240 * 4) throw Error('camera_invalid_pixels');
                    finish(null,toI420(pixels,320,240));
                } catch (error) { finish(error); }
            };
            image.src = url;
        });
    }
    capture(generation) {
        var self = this;
        Promise.resolve().then(function () {
            self.check(generation);
            return self.request('POST','/media/photo',{camera:1, type:1, filters:[]},65536);
        }).then(function (bytes) {
            self.check(generation);
            var photo;
            try { photo = JSON.parse(bytes.toString()); } catch (_) { throw Error('camera_invalid_photo'); }
            if (!photo || typeof photo.id !== 'string' || !photo.id.length || photo.id.length > 4096) throw Error('camera_invalid_photo');
            return self.request('GET','/media/photo?id=' + encodeURIComponent(photo.id),null,4 * 1024 * 1024);
        }).then(function (jpeg) {
            self.check(generation); return self.decode(jpeg,generation);
        }).then(function (frame) {
            self.check(generation);
            if (!self.ready) {
                self.ready = true; self.log.info('first decoded I420 frame (320x240) from a temporary PREVIEW photo');
                var resolve = self.resolveReady; self.resolveReady = self.rejectReady = self.starting = null; resolve();
            }
            self.emit('frame',frame);
            if (self.active && generation === self.generation) self.timer = setTimeout(function () {
                self.timer = null; self.capture(generation);
            },200);
        }).catch(function (error) {
            if (!self.active || generation !== self.generation) return;
            var ready = self.ready;
            self.stop(error);
            if (ready) self.emit('failure',error);
        });
    }
    stop(error) {
        var active = this.active; this.active = false; this.ready = false; ++this.generation;
        clearTimeout(this.timer); this.timer = null;
        if (this.rejectReady) this.rejectReady(error || Error('camera_closed'));
        this.resolveReady = this.rejectReady = this.starting = null;
        if (this.cancelRequest) this.cancelRequest(error);
        if (this.cancelDecode) this.cancelDecode(error);
        if (this.canvas) { this.canvas.width = this.canvas.height = 0; this.canvas = null; }
        if (active) this.log.info('stopped: preview requests/decode canceled; frame buffer released');
        return Promise.resolve();
    }
}
module.exports = PhotoCamera;
