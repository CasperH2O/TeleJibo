// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The live microphone for a call, from BEam 3.1.9's jibo.media.getUserMedia({audio: true}).
// Jibo keeps listening for "Hey Jibo" alongside it. The track's samples are read in the
// page and written to the helper as S16LE stereo 48 kHz (HELPER.md, fd 3). Nothing is
// recorded or stored, and no ALSA device, mixer or listening mode is touched.
// Runs on the robot's Node 6 / Chrome 53: ES2015 only.
var EventEmitter = require('events');

var RATE = 48000, BLOCK = 2048;
// At most 100 ms waits in the helper's pipe; beyond that whole blocks are dropped.
var QUEUE_LIMIT = 38400;
function queued(stream) { return typeof stream.writableLength === 'number' ? stream.writableLength : stream._writableState && stream._writableState.length || 0; }

// Mono float samples at `rate` to interleaved S16LE stereo at 48 kHz. `state` carries the
// read position and the last sample across blocks, so block edges make no click.
function pcm(samples, rate, state) {
    var step = rate / RATE, position = state.position || 0, last = state.last || 0, count = 0;
    for (var p = position; p < samples.length; p += step) ++count;
    var out = Buffer.alloc(count * 4), at = 0;
    for (; position < samples.length; position += step) {
        var index = Math.floor(position), fraction = position - index;
        // Sample -1 is the previous block's last one.
        var a = index > 0 ? samples[index - 1] : last, b = samples[index];
        var value = Math.max(-1, Math.min(1, a + (b - a) * fraction));
        var word = Math.round(value * 32767);
        out.writeInt16LE(word, at); out.writeInt16LE(word, at + 2); at += 4;
    }
    state.position = position - samples.length;
    if (samples.length) state.last = samples[samples.length - 1];
    return out;
}

class PageMicrophone extends EventEmitter {
    // options.active(): whether a call wants the audio now; outside a call it is discarded.
    constructor(jibo, options) {
        super(); this.jibo = jibo; this.options = options || {};
        this.closed = true; this.stream = null; this.context = null; this.source = null; this.processor = null;
        this.deadline = null; this.cancelStart = null; this.generation = 0;
        this.sent = 0; this.dropped = 0;
    }
    isPrivate() { return !!(this.jibo.privacyController && this.jibo.privacyController.enabled); }
    note(text) { if (this.options.log) this.options.log.info(text); }
    start(destination) {
        var self = this, options = this.options;
        if (!this.closed) return Promise.reject(Error('microphone_already_started'));
        if (this.isPrivate()) return Promise.reject(Error('microphone_privacy'));
        var getUserMedia = options.getUserMedia || (this.jibo.media && typeof this.jibo.media.getUserMedia === 'function' ?
            function (constraints) { return self.jibo.media.getUserMedia(constraints); } : null);
        var Context = options.AudioContext || (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext));
        if (!getUserMedia || !Context) return Promise.reject(Error('microphone_api_unavailable'));
        this.closed = false; this.sent = 0; this.dropped = 0;
        var generation = ++this.generation;
        return new Promise(function (resolve, reject) {
            var ready = false, failed = false;
            function current() { return !self.closed && generation === self.generation; }
            function fail(error) {
                if (!current() || failed) return;
                failed = true; self.cancelStart = null;
                self.stop();
                if (!ready) reject(error);
                self.emit('failure', error);
            }
            self.cancelStart = function () { if (!ready) reject(Error('microphone_closed')); };
            self.deadline = setTimeout(function () { fail(Error('microphone_no_frames')); }, options.timeoutMs || 5000);
            Promise.resolve().then(function () { return getUserMedia({audio: true}); }).then(function (stream) {
                if (!current()) { stream.getTracks().forEach(function (track) { track.stop(); }); return; }
                self.stream = stream;
                var context = self.context = new Context(), state = {};
                var source = self.source = context.createMediaStreamSource(stream);
                // A processor only runs while connected to the output; it writes silence there.
                var processor = self.processor = context.createScriptProcessor(BLOCK, 1, 1);
                self.note('microphone: live track at ' + context.sampleRate + ' Hz; helper input: stereo S16LE ' + RATE + ' Hz');
                processor.onaudioprocess = function (event) {
                    if (!current() || failed) return;
                    if (self.isPrivate()) return fail(Error('microphone_privacy'));
                    var bytes = pcm(event.inputBuffer.getChannelData(0), context.sampleRate, state);
                    try {
                        if (!options.active || options.active()) {
                            if (queued(destination) + bytes.length <= QUEUE_LIMIT) { destination.write(bytes); self.sent++; }
                            else self.dropped++;
                        }
                    } catch (error) { return fail(error); }
                    if (!ready) {
                        ready = true; clearTimeout(self.deadline); self.cancelStart = null;
                        self.note('microphone: first audio block (' + bytes.length + ' bytes)');
                        resolve();
                    }
                };
                stream.getTracks().forEach(function (track) { track.onended = function () { fail(Error('microphone_track_ended')); }; });
                source.connect(processor); processor.connect(context.destination);
            }).catch(function (error) { fail(error instanceof Error ? error : Error('microphone_refused')); });
        });
    }
    stop() {
        this.closed = true;
        clearTimeout(this.deadline);
        var cancel = this.cancelStart; this.cancelStart = null;
        if (cancel) cancel();
        var stream = this.stream, context = this.context, source = this.source, processor = this.processor;
        this.stream = this.context = this.source = this.processor = null;
        if (processor) { processor.onaudioprocess = null; try { processor.disconnect(); } catch (_) {} }
        if (source) try { source.disconnect(); } catch (_) {}
        if (stream) stream.getTracks().forEach(function (track) { track.onended = null; try { track.stop(); } catch (_) {} });
        if (context && typeof context.close === 'function') try { var closed = context.close(); if (closed && closed.catch) closed.catch(function () {}); } catch (_) {}
        return Promise.resolve();
    }
}
module.exports = PageMicrophone;
module.exports.pcm = pcm;
module.exports.RATE = RATE;
module.exports.QUEUE_LIMIT = QUEUE_LIMIT;
