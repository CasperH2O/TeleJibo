// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The native media service owns the sensor. Decode its loopback VP8/WebM stream
// with the robot's OpenMAX decoder and deliver fixed-size I420 frames in memory.
var events = require('events'), http = require('http'), net = require('net');
var childProcess = require('child_process');
var FRAME_BYTES = 320 * 240 * 3 / 2;

function reserveCheck() {
    return new Promise(function (resolve, reject) {
        var server = net.createServer();
        server.on('error', reject);
        server.listen(5000, '127.0.0.1', function () {
            var port = 5000;
            server.close(function (error) { if (error) reject(error); else resolve(port); });
        });
    });
}
class NativeCamera extends events.EventEmitter {
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {}; this.log = this.options.log;
        var records = jibo.records || [], record = records.filter(function (r) { return r.name === 'media'; })[0];
        this.address = record ? {host: record.host === '0.0.0.0' ? '127.0.0.1' : record.host, port: Number(record.port)} :
            {host: '127.0.0.1', port: 8486};
        this.child = null; this.ownsStream = false; this.closing = false; this.wanted = false;
        this.starting = null; this.stopping = null; this.cleaning = null; this.cancelReady = null;
        this.stall = null; this.retry = null; this.source = null; this.buffer = Buffer.alloc(0);
    }
    post(route, payload) {
        if (this.options.post) return this.options.post(route, payload);
        var address = this.address;
        return new Promise(function (resolve, reject) {
            var body = JSON.stringify(payload), settled = false;
            function finish(error) { if (settled) return; settled = true; clearTimeout(timer); if (error) reject(error); else resolve(); }
            var request = http.request({hostname: address.host, port: address.port, method: 'POST', path: route,
                headers: {'Host':'127.0.0.1:' + address.port, 'Content-Type':'application/json', 'Content-Length':Buffer.byteLength(body)}}, function (response) {
                response.resume();
                if (response.statusCode >= 200 && response.statusCode < 300) finish();
                else {
                    var error = Error('camera_http_' + response.statusCode);
                    error.notStarted = response.statusCode === 409;
                    finish(error);
                }
            });
            request.on('error', function (error) {
                error.notStarted = ['ECONNREFUSED','ENOTFOUND','EHOSTUNREACH','ENETUNREACH','EACCES'].indexOf(error.code) !== -1;
                finish(error);
            });
            var timer = setTimeout(function () { finish(Error('camera_http_timeout')); request.abort(); }, 5000);
            request.end(body);
        });
    }
    start() {
        var self = this;
        this.wanted = true;
        if (this.stopping) return this.stopping.then(function () {
            if (!self.wanted) throw Error('camera_closed');
            return self.start();
        });
        if (this.starting) return this.starting;
        if (this.child && !this.closing) return Promise.resolve();
        this.closing = false; this.buffer = Buffer.alloc(0);
        this.starting = Promise.resolve().then(function () {
            // An earlier ambiguous stop must finish before another start.
            if (self.ownsStream) return self.cleanup();
            var controller = self.jibo.cameraStreamController;
            if (controller && controller.state && controller.state !== 'off') throw Error('camera_busy');
        }).then(function () { return (self.options.reserveCheck || reserveCheck)(); }).then(function (port) {
            if (self.closing) throw Error('camera_closed');
            self.port = port; self.ownsStream = true;
            self.log.info('native camera start: service ' + self.address.host + ':' + self.address.port + ', loopback port ' + port);
            return self.post('/media/streaming/start', {enable:true, ip:'127.0.0.1', port:String(port)}).catch(function (error) {
                // Never stop another client's stream after a definite conflict.
                if (error.notStarted) self.ownsStream = false;
                throw error;
            });
        }).then(function () {
            if (self.closing) throw Error('camera_closed');
            return self.decode();
        }).catch(function (error) {
            return self.cleanup().then(function () { throw error; });
        }).then(function () { self.starting = null; }, function (error) { self.starting = null; throw error; });
        return this.starting;
    }
    decode() {
        var self = this, spawn = this.options.spawn || childProcess.spawn;
        return new Promise(function (resolve, reject) {
            var ready = false, said = '', finished = false;
            var timer = setTimeout(function () { finish(Error('camera_no_frames')); }, self.options.timeoutMs || 15000);
            function finish(error) {
                if (finished) return;
                if (error) {
                    finished = true; clearTimeout(timer); self.cancelReady = null;
                    if (!ready) reject(error);
                    else if (!self.closing) self.emit('failure', error);
                } else if (!ready) {
                    ready = true; clearTimeout(timer); self.cancelReady = null;
                    self.log.info('native camera: first decoded I420 frame (320x240)'); resolve();
                }
            }
            self.cancelReady = function () { finish(Error('camera_closed')); };
            var child = self.child = spawn('gst-launch-1.0', ['-q','fdsrc','fd=0','!',
                'matroskademux','!','omxvp8dec','!','videoconvert','!','videoscale','!','videorate','!',
                'video/x-raw,format=I420,width=320,height=240,framerate=10/1,pixel-aspect-ratio=1/1','!','fdsink','fd=1','sync=false'],
                {stdio:['pipe','pipe','pipe']});
            child.on('error', function (error) { if (self.child === child) finish(error); });
            child.stdin.on('error', function (error) { if (!self.closing && self.child === child) finish(error); });
            child.on('exit', function (code, signal) {
                if (!self.closing && self.child === child) finish(Error('camera_decoder_exit_' + code + '_' + signal + ': ' + said.trim()));
            });
            child.stderr.on('data', function (bytes) { said = (said + String(bytes)).slice(-1000); });
            function connect() {
                if (self.closing || finished || self.child !== child) return;
                var connected = false;
                var source = self.source = (self.options.connect || net.connect)({host:'127.0.0.1', port:self.port});
                source.on('connect', function () {
                    if (self.closing || self.child !== child) { source.destroy(); return; }
                    connected = true; source.pipe(child.stdin);
                });
                source.on('error', function (error) {
                    if (self.closing || finished || self.child !== child) return;
                    if (!connected && error.code === 'ECONNREFUSED') {
                        source.destroy();
                        self.retry = setTimeout(connect, 100);
                    } else finish(error);
                });
                source.on('end', function () { if (!self.closing && self.child === child) finish(Error('camera_stream_ended')); });
            }
            connect();
            child.stdout.on('data', function (bytes) {
                if (self.closing || finished || self.child !== child) return;
                clearTimeout(self.stall);
                self.stall = setTimeout(function () { finish(Error('camera_stalled')); }, 5000);
                // gst-launch's stdout is a byte stream; frame boundaries may split anywhere.
                var data = Buffer.concat([self.buffer, bytes]);
                var complete = Math.floor(data.length / FRAME_BYTES) * FRAME_BYTES;
                self.buffer = Buffer.from(data.slice(complete));
                for (var at = 0; at < complete && !self.closing; at += FRAME_BYTES) {
                    finish(); self.emit('frame', data.slice(at, at + FRAME_BYTES));
                }
            });
        });
    }
    cleanup() {
        if (this.cleaning) return this.cleaning;
        var self = this, child = this.child; this.child = null;
        clearTimeout(this.stall); clearTimeout(this.retry); this.stall = null; this.retry = null; this.buffer = Buffer.alloc(0);
        if (this.source) { this.source.destroy(); this.source = null; }
        var terminate = new Promise(function (resolve, reject) {
            if (!child || child.exitCode !== null && child.exitCode !== undefined) return resolve();
            var kill = setTimeout(function () { child.kill('SIGKILL'); }, 1000);
            var deadline = setTimeout(function () { clearTimeout(kill); reject(Error('camera_decoder_cleanup_timeout')); }, 2000);
            child.once('close', function () { clearTimeout(kill); clearTimeout(deadline); resolve(); });
            child.kill('SIGTERM');
        });
        var stop = this.ownsStream ? this.post('/media/streaming/control', {}).then(function () {
            self.ownsStream = false; self.log.info('native camera stopped');
        }) : Promise.resolve();
        this.cleaning = Promise.all([terminate, stop]).then(function () { self.cleaning = null; }, function (error) {
            self.cleaning = null; throw error;
        });
        return this.cleaning;
    }
    stop() {
        this.wanted = false;
        if (this.stopping) return this.stopping;
        var self = this; this.closing = true;
        if (this.cancelReady) this.cancelReady();
        // A POST may still start the service after stop was requested. Wait for it,
        // then send stop; never leave a late producer behind.
        this.stopping = Promise.resolve(this.starting).catch(function () {}).then(function () { return self.cleanup(); })
            .then(function () { self.stopping = null; }, function (error) { self.stopping = null; throw error; });
        return this.stopping;
    }
}
module.exports = NativeCamera;
