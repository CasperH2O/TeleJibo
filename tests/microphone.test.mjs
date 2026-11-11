import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Microphone = require('../telejibo/lib/microphone');

// A page microphone: a track, an audio context and a script processor that the test drives.
function devices(rate = 48000) {
    const tracks = [{stopped: 0, stop() { ++this.stopped; }}], contexts = [], requests = [];
    const stream = {getTracks: () => tracks};
    class Context {
        constructor() { this.sampleRate = rate; this.destination = {}; this.closed = 0; this.nodes = []; contexts.push(this); }
        node() { const n = {connected: [], disconnected: 0, connect(to) { this.connected.push(to); }, disconnect() { ++this.disconnected; }}; this.nodes.push(n); return n; }
        createMediaStreamSource(s) { assert.equal(s, stream); return this.source = this.node(); }
        createScriptProcessor(size, inputs, outputs) { assert.deepEqual([inputs, outputs], [1, 1]); return this.processor = this.node(); }
        close() { ++this.closed; return Promise.resolve(); }
    }
    const pipe = Object.assign(new EventEmitter(), {writableLength: 0, writes: [], write(bytes) { this.writes.push(bytes); return true; }});
    const block = (samples) => contexts[0].processor.onaudioprocess({inputBuffer: {getChannelData: () => Float32Array.from(samples)}});
    const getUserMedia = (constraints) => { requests.push(constraints); return Promise.resolve(stream); };
    return {tracks, contexts, requests, stream, Context, pipe, block, getUserMedia};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('pcm: 48 kHz mono becomes S16LE stereo, clipped, one sample behind, with nothing lost across blocks', () => {
    const state = {}, bytes = Microphone.pcm(Float32Array.from([0.25, 0.5, -0.5, 2, -2]), 48000, state);
    assert.equal(bytes.length, 5 * 4);
    const words = [...Array(10).keys()].map(i => bytes.readInt16LE(i * 2)), full = v => Math.round(v * 32767);
    assert.deepEqual(words, [0, 0, full(0.25), full(0.25), full(0.5), full(0.5), full(-0.5), full(-0.5), 32767, 32767]);
    // The block's last sample opens the next block.
    assert.equal(Microphone.pcm(Float32Array.from([0.25]), 48000, state).readInt16LE(0), -32767);
});

test('pcm: other rates are resampled to 48 kHz with a steady total', () => {
    for (const rate of [16000, 44100, 96000]) {
        const state = {}; let frames = 0;
        for (let i = 0; i < 50; ++i) frames += Microphone.pcm(new Float32Array(2048).fill(0.5), rate, state).length / 4;
        const expected = 50 * 2048 * 48000 / rate;
        assert.ok(Math.abs(frames - expected) <= 1, rate + ': ' + frames + ' vs ' + expected);
    }
    // A constant input stays constant: no clicks at block edges.
    const state = {}, values = new Set();
    for (let i = 0; i < 4; ++i) { const b = Microphone.pcm(new Float32Array(441).fill(0.5), 44100, state); for (let j = i ? 0 : 8; j < b.length; j += 2) values.add(b.readInt16LE(j)); }
    assert.deepEqual([...values], [Math.round(0.5 * 32767)]);
});

test('the microphone asks only for audio, is ready on its first block and sends only during a call', async () => {
    const d = devices(); let active = false;
    const microphone = new Microphone({}, {getUserMedia: d.getUserMedia, AudioContext: d.Context, active: () => active});
    let ready = false; const started = microphone.start(d.pipe).then(() => { ready = true; });
    await tick();
    assert.deepEqual(d.requests, [{audio: true}]);
    assert.equal(ready, false);
    assert.deepEqual(d.contexts[0].processor.connected, [d.contexts[0].destination]);
    d.block(new Array(2048).fill(0.1)); await started;
    assert.equal(d.pipe.writes.length, 0, 'nothing leaves Jibo outside a call');
    active = true; d.block(new Array(2048).fill(0.1));
    assert.equal(d.pipe.writes.length, 1);
    assert.equal(d.pipe.writes[0].length, 2048 * 4);
    await microphone.stop();
    assert.equal(d.tracks[0].stopped, 1); assert.equal(d.contexts[0].closed, 1);
    assert.equal(d.contexts[0].processor.onaudioprocess, null);
});

test('a full helper pipe drops whole blocks instead of delaying the call', async () => {
    const d = devices(), microphone = new Microphone({}, {getUserMedia: d.getUserMedia, AudioContext: d.Context});
    const started = microphone.start(d.pipe); await tick();
    d.pipe.writableLength = Microphone.QUEUE_LIMIT; d.block(new Array(2048).fill(0)); await started;
    assert.equal(d.pipe.writes.length, 0); assert.equal(microphone.dropped, 1);
    d.pipe.writableLength = 0; d.block(new Array(2048).fill(0));
    assert.equal(d.pipe.writes.length, 1);
    await microphone.stop();
});

test('privacy mode refuses the microphone and ends a running one', async () => {
    const d = devices(), jibo = {privacyController: {enabled: true}};
    const microphone = new Microphone(jibo, {getUserMedia: d.getUserMedia, AudioContext: d.Context});
    await assert.rejects(microphone.start(d.pipe), /microphone_privacy/);
    assert.equal(d.requests.length, 0);
    jibo.privacyController.enabled = false;
    const failures = []; microphone.on('failure', e => failures.push(e.message));
    const started = microphone.start(d.pipe); await tick(); d.block([0]); await started;
    jibo.privacyController.enabled = true; d.block([0.5]);
    assert.deepEqual(failures, ['microphone_privacy']);
    assert.equal(d.pipe.writes.length, 1);
    assert.equal(d.tracks[0].stopped, 1);
});

test('a refused, silent or ended microphone fails and releases the track', async () => {
    const refused = new Microphone({}, {getUserMedia: () => Promise.reject(Error('NotAllowedError')), AudioContext: devices().Context});
    await assert.rejects(refused.start(devices().pipe), /NotAllowedError/);
    const d = devices(), silent = new Microphone({}, {getUserMedia: d.getUserMedia, AudioContext: d.Context, timeoutMs: 20});
    await assert.rejects(silent.start(d.pipe), /microphone_no_frames/);
    assert.equal(d.tracks[0].stopped, 1);
    const e = devices(), ended = new Microphone({}, {getUserMedia: e.getUserMedia, AudioContext: e.Context});
    const failures = []; ended.on('failure', error => failures.push(error.message));
    const started = ended.start(e.pipe); await tick(); e.block([0]); await started;
    e.tracks[0].onended();
    assert.deepEqual(failures, ['microphone_track_ended']);
    await assert.rejects(new Microphone({}, {}).start(e.pipe), /microphone_api_unavailable/);
});

test('stop during start rejects at once and stops a track that arrives late', async () => {
    const d = devices(); let give;
    const microphone = new Microphone({}, {getUserMedia: () => new Promise(resolve => { give = resolve; }), AudioContext: d.Context});
    const started = microphone.start(d.pipe); await tick();
    microphone.stop();
    await assert.rejects(started, /microphone_closed/);
    give(d.stream); await tick();
    assert.equal(d.tracks[0].stopped, 1); assert.equal(d.contexts.length, 0);
});
