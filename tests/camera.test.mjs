// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const CallCamera = require('../telejibo/lib/camera');
const {StreamCamera, record} = CallCamera;
const tick = (ms = 0) => new Promise(resolve => ms ? setTimeout(resolve, ms) : setImmediate(resolve));

// BEam's jibo.media.getCameraStream, driven by the test, and the helper's camera pipe.
function devices(overrides = {}) {
    const streams = [], pipe = Object.assign(new EventEmitter(), {writableLength: 0, writes: [], write(bytes) { this.writes.push(bytes); return true; }});
    const jibo = {privacyController: {enabled: false}, media: {getCameraStream(onData) {
        const stream = {onData, stopped: 0, stop() { ++this.stopped; }};
        streams.push(stream);
        if (overrides.refuse) { const error = overrides.refuse(streams.length); if (error) return Promise.reject(error); }
        return Promise.resolve({mimeType: 'video/webm; codecs="vp8"', stop: () => stream.stop()});
    }}};
    class Photo extends EventEmitter {
        constructor() { super(); this.started = 0; this.stopped = 0; }
        start() { ++this.started; return overrides.photoFails ? Promise.reject(Error('camera_no_frames')) : Promise.resolve(); }
        stop() { ++this.stopped; return Promise.resolve(); }
    }
    const photo = new Photo();
    const parse = bytes => ({magic: bytes.toString('ascii', 0, 4), length: bytes.readUInt32LE(4), serial: bytes.readUInt32LE(8), index: bytes.readUInt32LE(12), body: bytes.slice(16)});
    return {streams, pipe, jibo, photo, parse};
}
const camera = (d, options = {}) => new CallCamera(d.jibo, {destination: d.pipe, photo: d.photo, restartGap: 0, ...options});

test('record: JIWM, length, serial and index, then the bytes', () => {
    const bytes = record(7, 3, Buffer.from('abc'));
    assert.equal(bytes.toString('ascii', 0, 4), 'JIWM');
    assert.deepEqual([bytes.readUInt32LE(4), bytes.readUInt32LE(8), bytes.readUInt32LE(12)], [3, 7, 3]);
    assert.equal(bytes.slice(16).toString(), 'abc');
});

test('the live stream goes to the helper in order, in bounded pieces, and stops with the camera', async () => {
    const d = devices(), c = camera(d);
    assert.equal(c.mode, 'stream');
    await c.probe(); assert.equal(d.photo.started, 0, 'the stream needs no trial photo');
    let ready = false; const started = c.start().then(() => { ready = true; });
    await tick(); assert.equal(ready, false, 'a connected encoder is not yet video');
    d.streams[0].onData(Buffer.alloc(10, 1)); await started;
    d.streams[0].onData(Buffer.alloc(CallCamera.PIECE + 5, 2));
    const records = d.pipe.writes.map(d.parse);
    assert.deepEqual(records.map(r => r.index), [0, 1, 2]);
    assert.deepEqual(records.map(r => r.length), [10, CallCamera.PIECE, 5]);
    assert.ok(records.every(r => r.magic === 'JIWM' && r.serial === records[0].serial && r.body.length === r.length));
    assert.equal(d.photo.started, 0);
    await c.stop();
    assert.equal(d.streams[0].stopped, 1);
    d.streams[0].onData(Buffer.alloc(10)); assert.equal(d.pipe.writes.length, 3, 'nothing after stop');
});

test('a keyframe request starts a new stream with a new serial from index 0, never two at once', async () => {
    const d = devices(), c = camera(d);
    const started = c.start(); await tick(); d.streams[0].onData(Buffer.alloc(4)); await started;
    c.restart(); c.restart(); await tick(5);
    assert.equal(d.streams.length, 2); assert.equal(d.streams[0].stopped, 1);
    d.streams[0].onData(Buffer.alloc(4)); d.streams[1].onData(Buffer.alloc(4));
    const records = d.pipe.writes.map(d.parse);
    assert.equal(records.length, 2);
    assert.notEqual(records[1].serial, records[0].serial); assert.equal(records[1].index, 0);
    await c.stop(); c.restart(); await tick(5);
    assert.equal(d.streams.length, 2, 'no stream after the camera is off');
});

test('restarts are spaced out and a full helper pipe starts over instead of dropping bytes', async () => {
    const d = devices(), c = camera(d, {restartGap: 40, queueLimit: 100});
    const started = c.start(); await tick(); d.streams[0].onData(Buffer.alloc(4)); await started;
    c.restart(); await tick(10);
    assert.equal(d.streams.length, 1, 'too soon after the stream started');
    await tick(50); assert.equal(d.streams.length, 2);
    d.streams[1].onData(Buffer.alloc(4));
    d.pipe.writableLength = 101; d.streams[1].onData(Buffer.alloc(4));
    assert.equal(d.pipe.writes.length, 2, 'not written into a full pipe');
    d.pipe.writableLength = 0; await tick(60);
    assert.equal(d.streams.length, 3);
    await c.stop();
});

test('a camera that is still closing is retried; one that stays in use falls back to photos', async () => {
    const busy = Error('Camera is in use');
    const d = devices({refuse: n => n < 3 ? busy : null}), c = camera(d);
    const started = c.start(); await tick(700);
    assert.equal(d.streams.length, 3); d.streams[2].onData(Buffer.alloc(4)); await started;
    assert.equal(c.mode, 'stream'); await c.stop();

    const e = devices({refuse: () => Error('Camera service HTTP 404')}), f = camera(e);
    await f.start();
    assert.equal(f.mode, 'photo'); assert.equal(e.photo.started, 1);
    const frames = []; f.on('frame', bytes => frames.push(bytes));
    e.photo.emit('frame', Buffer.alloc(8)); assert.equal(frames.length, 1);
    f.restart(); await tick(5); assert.equal(e.streams.length, 1, 'photos have no keyframes to ask for');
    await f.stop(); assert.ok(e.photo.stopped >= 1);
});

test('a stream that goes quiet falls back to photos; privacy mode ends the camera', async () => {
    const d = devices(), c = camera(d, {stallMs: 30});
    const started = c.start(); await tick(); d.streams[0].onData(Buffer.alloc(4)); await started;
    await tick(700);
    assert.equal(c.mode, 'photo'); assert.equal(d.streams[0].stopped, 1); assert.equal(d.photo.started, 1);
    await c.stop();

    const e = devices(), f = camera(e), failures = [];
    f.on('failure', error => failures.push(error.message));
    const again = f.start(); await tick(); e.streams[0].onData(Buffer.alloc(4)); await again;
    e.jibo.privacyController.enabled = true; await tick(600);
    assert.deepEqual(failures, ['privacy_enabled']);
    assert.equal(e.photo.started, 0); assert.equal(e.streams[0].stopped, 1);
    const g = devices(); g.jibo.privacyController.enabled = true;
    await assert.rejects(new StreamCamera(g.jibo, {destination: g.pipe}).start(), /privacy_enabled/);
});

test('without the stream API, or when told not to use it, the camera is the photo path with its trial frame', async () => {
    const d = devices(); delete d.jibo.media.getCameraStream;
    const c = camera(d);
    assert.equal(c.mode, 'photo');
    await c.probe(); assert.deepEqual([d.photo.started, d.photo.stopped], [1, 1]);
    await c.start(); assert.equal(d.photo.started, 2);
    const failures = []; c.on('failure', error => failures.push(error.message));
    d.photo.emit('failure', Error('camera_stalled')); assert.deepEqual(failures, ['camera_stalled']);
    assert.equal(camera(devices(), {stream: false}).mode, 'photo');
    assert.equal(c.summary(), null);
});

test('stop during start stops a stream that arrives late and sends nothing', async () => {
    const d = devices(); let give;
    d.jibo.media.getCameraStream = (onData) => new Promise(resolve => { give = () => { const s = {stopped: 0, stop() { ++this.stopped; }}; d.streams.push(s); resolve(s); onData(Buffer.alloc(4)); }; });
    const c = camera(d); c.start(); await tick();
    await c.stop(); give(); await tick();
    assert.equal(d.streams[0].stopped, 1); assert.equal(d.pipe.writes.length, 0); assert.equal(d.photo.started, 0);
});
