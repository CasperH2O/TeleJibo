// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const SelfView = require('../telejibo/lib/self-view');
const RobotMedia = require('../telejibo/lib/media');

// A page with MediaSource and canvases that record what is drawn.
function page() {
    const sources = [], videos = [], draws = [], revoked = [];
    class Buffer extends EventTarget {
        constructor() { super(); this.updating = false; this.appended = []; this.removed = []; }
        appendBuffer(bytes) { this.appended.push(bytes); this.updating = true; }
        remove(a, b) { this.removed.push([a, b]); this.updating = true; }
        done() { this.updating = false; this.dispatchEvent(new Event('updateend')); }
    }
    class MediaSource extends EventTarget {
        constructor() { super(); this.readyState = 'closed'; this.buffers = []; sources.push(this); }
        addSourceBuffer(mime) { this.mime = mime; const b = new Buffer(); this.buffers.push(b); return b; }
        open() { this.readyState = 'open'; this.dispatchEvent(new Event('sourceopen')); }
        endOfStream() { this.readyState = 'ended'; }
        static isTypeSupported(mime) { return /vp8/.test(mime); }
    }
    const context = () => ({save() {}, restore() {}, translate() {}, scale() {}, drawImage(...args) { draws.push(args); },
        createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}), putImageData() {}});
    const document = {createElement(kind) {
        if (kind === 'canvas') return {width: 0, height: 0, getContext: context};
        const video = {muted: false, paused: true, readyState: 0, videoWidth: 0, videoHeight: 0, currentTime: 0, ranges: [],
            get buffered() { const r = this.ranges; return {length: r.length, start: i => r[i][0], end: i => r[i][1]}; },
            play() { this.paused = false; return Promise.resolve(); }, pause() { this.paused = true; }, removeAttribute() {}, load() {}};
        videos.push(video); return video;
    }};
    return {host: {document, MediaSource, URL: {createObjectURL: () => 'blob:self', revokeObjectURL: url => revoked.push(url)}}, sources, videos, draws, revoked};
}

test('self view: stream bytes are decoded by the page, in order, as a copy, and painted mirrored into a 16:9 tile', () => {
    const p = page(), painted = [];
    const view = new SelfView(p.host, canvas => painted.push(canvas));
    const first = Buffer.from([1, 2, 3]);
    view.stream(first, 5); view.stream(Buffer.from([4]), 5);
    assert.equal(p.sources.length, 1);
    p.sources[0].open();
    const buffer = p.sources[0].buffers[0];
    assert.equal(p.sources[0].mime, 'video/webm; codecs="vp8"'); assert.equal(buffer.mode, 'sequence');
    assert.deepEqual([...buffer.appended[0]], [1, 2, 3]);
    first[0] = 9; assert.equal(buffer.appended[0][0], 1, 'the camera may reuse its buffer');
    assert.equal(buffer.appended.length, 1, 'one append at a time');
    buffer.done(); assert.deepEqual([...buffer.appended[1]], [4]);
    assert.equal(p.videos[0].muted, true); assert.equal(p.videos[0].paused, false);
    view.paint(); assert.equal(painted.length, 0, 'no picture yet');
    Object.assign(p.videos[0], {readyState: 4, videoWidth: 1280, videoHeight: 720}); view.paint();
    assert.equal(painted.length, 1);
    assert.deepEqual([painted[0].width, painted[0].height], [208, 117]);
    assert.deepEqual(p.draws.at(-1).slice(1), [0, 0, 1280, 720, 0, 0, 208, 117]);
    view.stop();
});

test('self view: it stays live, lets go of old video, and starts over for a new stream', () => {
    const p = page(), view = new SelfView(p.host, () => {});
    view.stream(Buffer.from([1]), 1); p.sources[0].open();
    const buffer = p.sources[0].buffers[0], video = p.videos[0];
    video.ranges = [[0, 12]]; video.currentTime = 2;
    view.stream(Buffer.from([2]), 1); buffer.done();
    assert.equal(video.currentTime, 11.9, 'jumped to the live edge');
    assert.deepEqual(buffer.removed, [[0, 8]]);
    view.stream(Buffer.from([3]), 2);
    assert.equal(p.sources.length, 2); assert.equal(p.sources[0].readyState, 'ended'); assert.deepEqual(p.revoked, ['blob:self']);
    view.stop(); view.stream(Buffer.from([4]), 3);
    assert.equal(p.sources.length, 2, 'nothing after stop');
});

test('self view: preview frames are drawn directly, cropped to the tile; a page without MediaSource ignores the stream', () => {
    const p = page(), painted = [], view = new SelfView(p.host, canvas => painted.push(canvas));
    view.frame(Buffer.alloc(320 * 240 * 3 / 2), 320, 240, (bytes, w, h, rgba) => rgba.fill(255));
    assert.equal(painted.length, 1);
    const [, sx, sy, sw, sh] = p.draws.at(-1);
    assert.ok(Math.abs(sw / sh - 208 / 117) < 0.01 && sx === 0 && sy > 0, 'a centred 16:9 crop of the 4:3 frame');
    delete p.host.MediaSource;
    assert.equal(SelfView.supported(p.host), false);
    view.stream(Buffer.from([1]), 1); assert.equal(p.sources.length, 0);
});

test('media: the self view runs only while the camera sends and the person wants it', async () => {
    const p = page(), pipe = () => Object.assign(new EventEmitter(), {writableLength: 0, write: () => true});
    const helper = {stdio: [null, null, null, pipe(), pipe(), pipe(), pipe()]};
    const child = () => Object.assign(new EventEmitter(), {exitCode: null, stderr: new EventEmitter(), stdin: pipe(), kill() { this.exitCode = 0; setImmediate(() => this.emit('close', 0)); }});
    class Photo extends EventEmitter { start() { return Promise.resolve(); } stop() { return Promise.resolve(); } }
    class Microphone extends EventEmitter { start() { return Promise.resolve(); } stop() { return Promise.resolve(); } }
    const saved = globalThis.document; globalThis.document = p.host.document;
    try {
        const media = new RobotMedia({media: {}}, {spawn: child, camera: Photo, microphone: Microphone, selfView: true, page: p.host});
        const seen = []; media.on('self', canvas => seen.push(canvas));
        await media.start(helper);
        assert.equal(media.selfView, null, 'not before a call');
        media.setCallActive(true); media.setCamera(true); await media.cameraTransition;
        assert.ok(media.selfView);
        media.cameraSource.emit('stream', Buffer.from([1]), 1); assert.equal(p.sources.length, 1);
        media.cameraSource.photo.emit('frame', Buffer.alloc(115200)); assert.equal(seen.length, 1);
        media.setSelfView(false);
        assert.equal(media.selfView, null); assert.equal(seen.at(-1), null);
        media.setSelfView(true); assert.ok(media.selfView);
        media.setCamera(false); assert.equal(media.selfView, null);
        await media.stop();
    } finally { globalThis.document = saved; }
});
