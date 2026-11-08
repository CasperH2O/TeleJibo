// Unit tests for TeleJibo: layout rules, the app key, helper launch and packaging, media
// framing and device lifecycle, and the skill controller (with fake SDK, helper and devices).
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const layout = require('../telejibo/lib/layout.js');
const credentials = require('../telejibo/lib/credentials.js');
const Supervisor = require('../telejibo/lib/helper.js');
const KEY = {api_id: 123456, api_hash: '0123456789abcdef0123456789abcdef'};
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'telejibo-test-'));

test('every control sits inside the round-cornered safe area', () => {
    const rects = [];
    for (let i = 0; i < layout.contacts.perPage; ++i) rects.push(['contact' + i, layout.slot(i)]);
    for (const mode of ['portrait', 'landscape']) {
        layout.callButtons.forEach((name, i) => { const b = layout.rowButton(mode, i); rects.push([mode + ':' + name, {x: b.x, y: b.y, width: b.size, height: b.size}]); });
    }
    const n = layout.incoming, s = layout.settings, h = layout.header.settings;
    for (const id of ['decline', 'accept', 'cancel']) rects.push([id, {x: n[id].x, y: n[id].y, width: n.button, height: n.button}]);
    for (const id of ['signOut', 'back']) rects.push([id, {x: s[id].x, y: s[id].y, width: s.button, height: s.button}]);
    rects.push(['settings', {x: h.x, y: h.y, width: h.size, height: h.size}]);
    for (const [id, rect] of rects) assert.ok(layout.safe(rect), id + ' ' + JSON.stringify(rect));
});

test('controls are at least the 64 px touch floor and contact tiles match the stock 330 px tile', () => {
    for (const mode of ['portrait', 'landscape']) for (let i = 0; i < 4; ++i) assert.ok(layout.rowButton(mode, i).size >= 64);
    assert.ok(layout.header.settings.size >= 64);
    assert.equal(layout.contacts.width, 330);
    assert.equal(layout.actionScale(132), 0.5);
});

test('portrait row buttons do not overlap and landscape row is centred', () => {
    const p = [0, 1, 2, 3].map((i) => layout.rowButton('portrait', i));
    for (let i = 1; i < 4; ++i) assert.ok(p[i].x >= p[i - 1].x + p[i - 1].size);
    const l = [0, 1, 2, 3].map((i) => layout.rowButton('landscape', i));
    assert.equal(Math.round((l[0].x + l[3].x + l[3].size) / 2), 640);
});

test('contacts fill down each column, most recent top left', () => {
    assert.deepEqual([0, 1, 2].map((i) => [layout.slot(i).x, layout.slot(i).y]), [[112, 132], [112, 399], [474.5, 132]]);
});

test('pager follows the stock track and hides for one page', () => {
    assert.equal(layout.pager(0, 6), null);
    const first = layout.pager(0, 18), last = layout.pager(12, 18);
    assert.equal(first.track.width, 1190);
    assert.equal(first.thumb.x, 45);
    assert.equal(last.thumb.x + last.thumb.width, 45 + 1190);
});

test('video is cropped, never stretched, into its box', () => {
    const portrait = layout.video(480, 640), landscape = layout.video(640, 480);
    assert.equal(portrait.mode, 'portrait');
    assert.equal(landscape.mode, 'landscape');
    for (const v of [portrait, landscape]) {
        assert.ok(Math.abs(v.crop.width / v.crop.height - v.rect.width / v.rect.height) < 0.02);
    }
});

test('paging helpers', () => {
    assert.deepEqual(layout.neighbours(0, 8), {previous: 0, next: 2});
    assert.equal(layout.release(-200, {previous: 0, next: 6}), 1);
    assert.equal(layout.release(-100, {previous: 0, next: 6}), 0);
    assert.equal(layout.release(200, {previous: 0, next: 6}), 0);
    let state = {x: -992, velocity: 0, settled: false};
    for (let i = 0; i < 200 && !state.settled; ++i) state = layout.spring(state, 0);
    assert.deepEqual(state, {x: 0, velocity: 0, settled: true});
    assert.equal(layout.counter(6, 13), '2 / 3');
    assert.equal(layout.duration(3725000), '1:02:05');
});

test('text fits with an ellipsis and copy never names Telegram outside sign-in', () => {
    assert.equal(layout.fit('Alexandra', 5, (s) => s.length), 'Alex…');
    assert.equal(layout.initials('  ada  lovelace king '), 'AL');
    for (const [key, value] of Object.entries(layout.text)) {
        if (key === 'linkTitle' || key === 'steps') continue;
        assert.ok(!/telegram/i.test(String(value)), key);
    }
});

test('app key round trip, and the scrambled form hides the plain hash', () => {
    const bytes = credentials.encode(KEY);
    assert.deepEqual(credentials.decode(bytes), KEY);
    assert.ok(!bytes.includes(Buffer.from(KEY.api_hash)));
    assert.ok(!bytes.includes(Buffer.from(String(KEY.api_id))));
    assert.throws(() => credentials.encode({api_id: '1', api_hash: KEY.api_hash}));
    assert.throws(() => credentials.decode(Buffer.from('TJK1garbage')));
});

test('apiFile writes the bundled key privately, and an override wins whatever its mode', () => {
    const app = temp(), data = temp();
    assert.equal(credentials.apiFile(app, data), null);
    fs.mkdirSync(path.join(app, 'config'));
    fs.writeFileSync(path.join(app, 'config/app-key.bin'), credentials.encode(KEY));
    const file = credentials.apiFile(app, data);
    assert.equal(file, path.join(data, 'api.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const own = {api_id: 7, api_hash: 'ffffffffffffffffffffffffffffffff'};
    fs.writeFileSync(path.join(data, 'api.override.json'), JSON.stringify(own), {mode: 0o644});
    // The helper refuses a key file others may read, so the override is copied privately.
    assert.equal(credentials.apiFile(app, data), file);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), own);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(path.join(data, 'api.override.json'), '{"api_id": 7}');
    assert.throws(() => credentials.apiFile(app, data));
});

test('helper launch grants execute permission, else uses the loader', () => {
    const app = temp(), bin = path.join(app, 'bin', 'telegram-helper');
    fs.mkdirSync(path.dirname(bin)); fs.writeFileSync(bin, 'x', {mode: 0o644});
    assert.deepEqual(Supervisor.launch(app), {command: bin, prefix: []});
    assert.ok(fs.statSync(bin).mode & 0o100);
    const refusing = {statSync: () => ({mode: 0o100644}), chmodSync: () => { throw Object.assign(Error('EPERM'), {code: 'EPERM'}); }, existsSync: () => true};
    assert.deepEqual(Supervisor.launch(app, {fs: refusing, loader: '/lib/ld.so'}),
        {command: '/lib/ld.so', prefix: ['--library-path', path.join(app, 'bin'), bin]});
    assert.throws(() => Supervisor.launch(app, {fs: Object.assign({}, refusing, {existsSync: () => false})}), /helper_not_executable/);
});

test('supervisor starts the helper with private pipes and the heartbeat lease', () => {
    const calls = [];
    const fakeChild = () => {
        const {EventEmitter} = require('events');
        const child = new EventEmitter();
        child.stdin = Object.assign(new EventEmitter(), {write: () => true, end: () => {}});
        child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
        return child;
    };
    const timers = {setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {}};
    const s = new Supervisor({appRoot: '/app', dataRoot: '/data', apiFile: '/data/api.json', stateDir: '/data/account', media: true, timers,
        launch: () => ({command: '/app/bin/telegram-helper', prefix: []}), spawn: (cmd, args, options) => { calls.push([cmd, args, options]); return fakeChild(); }});
    assert.equal(s.start(), true);
    const [cmd, args, options] = calls[0];
    assert.equal(cmd, '/app/bin/telegram-helper');
    assert.deepEqual(args, ['--api-file', '/data/api.json', '--state-dir', '/data/account', '--require-heartbeat', '--pipe-media']);
    assert.equal(options.stdio.length, 7);
    assert.equal(options.env.LD_LIBRARY_PATH, '/app/bin');
    const events = [];
    s.on('status', (v) => events.push(v.event)); s.on('failure', (r) => events.push('failure:' + r));
    s.child.stdout.emit('data', Buffer.from('{"event":"authorization","state":"qr"}\n{"event":"bogus"}\n'));
    assert.deepEqual(events, ['authorization', 'failure:helper_protocol']);
});

test('package: limits, layout and no plain key in the ZIP', (t) => {
    const work = temp(), payload = path.join(work, 'payload'), live = path.join(work, 'helper-source');
    for (const dir of ['bin', 'licenses/x', 'source/media']) fs.mkdirSync(path.join(payload, dir), {recursive: true});
    fs.mkdirSync(path.join(live, 'media'), {recursive: true});
    fs.writeFileSync(path.join(payload, 'bin/telegram-helper'), 'helper');
    fs.writeFileSync(path.join(payload, 'bin/libtdjson.so.1.8.69'), 'tdjson');
    fs.writeFileSync(path.join(payload, 'licenses/x/LICENSE'), 'license');
    for (const dir of [path.join(payload, 'source'), live]) fs.writeFileSync(path.join(dir, 'media/helper.cpp'), '// source');
    for (const name of ['LICENSE.md', 'THIRD_PARTY.md', 'BUILD-SOURCES.json', 'ACCOUNT-SOURCES.json']) fs.writeFileSync(path.join(payload, name), name);
    const digest = (name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(payload, 'bin', name))).digest('hex');
    // The same source hash the helper build records (helper/stage.py).
    const sourceHash = execFileSync('python3', ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import stage,pathlib;print(stage.source_digest(stage.source_files(pathlib.Path(sys.argv[2]))))',
        path.join(root, 'helper'), live], {encoding: 'utf8'}).trim();
    const record = () => fs.writeFileSync(path.join(payload, 'stage.json'), JSON.stringify({
        binaries: {'telegram-helper': digest('telegram-helper'), 'libtdjson.so.1.8.69': digest('libtdjson.so.1.8.69')}, source_sha256: sourceHash}));
    record();
    const key = path.join(work, 'api.json'); fs.writeFileSync(key, JSON.stringify(KEY));
    const zip = path.join(work, 'out.zip');
    const pack = (...extra) => spawnSync('python3', [path.join(root, 'tools/package.py'), '--helper-payload', payload, '--helper-source', live, '--output', zip, ...extra], {encoding: 'utf8'});
    const run = pack('--api-file', key);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.ok(result.entries < 1024 && result.app_key);
    const bytes = fs.readFileSync(zip);
    assert.ok(!bytes.includes(Buffer.from(KEY.api_hash)));
    const names = execFileSync('python3', ['-c', 'import sys,zipfile;print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', zip], {encoding: 'utf8'}).trim().split('\n');
    for (const name of ['manifest.json', 'icon.png', 'telejibo/package.json', 'telejibo/index.js', 'telejibo/bin/telegram-helper',
        'telejibo/config/app-key.bin', 'telejibo/vendor/qrcode.js', 'telejibo/helper/source/media/helper.cpp', 'telejibo/helper/stage.json',
        'telejibo/resources/icons/video.png']) {
        assert.ok(names.includes(name), name);
    }
    assert.ok(!names.some((n) => n.includes('tests/')));
    // A binary that differs from the build record is refused.
    fs.writeFileSync(path.join(payload, 'bin/telegram-helper'), 'other');
    let refused = pack();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /does not match stage\.json/);
    // Binaries built from older helper source than the tree being packaged are refused.
    fs.writeFileSync(path.join(payload, 'bin/telegram-helper'), 'helper');
    fs.writeFileSync(path.join(live, 'media/helper.cpp'), '// edited since the build');
    refused = pack();
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /source changed since the binaries were built/);
    // A directory that is not a staged payload is refused with a pointer to the build.
    refused = spawnSync('python3', [path.join(root, 'tools/package.py'), '--helper-payload', work, '--output', zip], {encoding: 'utf8'});
    assert.match(refused.stderr, /not a staged helper payload/);
});

test('helper source snapshot excludes build output and links', () => {
    const dir = temp();
    fs.mkdirSync(path.join(dir, 'data'), {recursive: true}); fs.mkdirSync(path.join(dir, '__pycache__'));
    fs.writeFileSync(path.join(dir, 'a.py'), '1'); fs.writeFileSync(path.join(dir, 'data/big.bin'), 'x'); fs.writeFileSync(path.join(dir, '__pycache__/a.pyc'), 'x');
    const listing = (extra) => execFileSync('python3', ['-c', 'import sys;sys.path.insert(0,sys.argv[1]);import stage,pathlib;print(",".join(r.as_posix() for r,_ in stage.source_files(pathlib.Path(sys.argv[2]))))',
        path.join(root, 'helper'), dir], {encoding: 'utf8'}).trim();
    assert.equal(listing(), 'a.py');
    fs.symlinkSync('a.py', path.join(dir, 'link.py'));
    assert.throws(() => listing(), /Linked source input/);
});

// ---- Media framing and device lifecycle (lib/media.js), with fake devices.
const RobotMedia = require('../telejibo/lib/media.js');
const {EventEmitter} = require('events');
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test('received video frames survive split chunks; bad headers are refused', () => {
    const frames = [];
    const decoder = new RobotMedia.VideoFrames((bytes, width, height) => frames.push([width, height, bytes[0], bytes.length]));
    const header = Buffer.alloc(12); header.write('JIVF', 0, 'ascii'); header.writeUInt32LE(4, 4); header.writeUInt32LE(2, 8);
    const frame = Buffer.concat([header, Buffer.alloc(12, 9)]);
    const both = Buffer.concat([frame, frame]);
    for (const [from, to] of [[0, 1], [1, 13], [13, 30], [30, both.length]]) decoder.write(both.slice(from, to));
    assert.deepEqual(frames, [[4, 2, 9, 12], [4, 2, 9, 12]]);
    assert.throws(() => new RobotMedia.VideoFrames(() => {}).write(Buffer.from('XXXX00000000')), /video_pipe_header/);
    const odd = Buffer.from(header); odd.writeUInt32LE(3, 4);
    assert.throws(() => new RobotMedia.VideoFrames(() => {}).write(odd), /video_pipe_dimensions/);
});

test('camera frames build with the simulator Buffer, which has no write(string)', () => {
    // The simulator's Buffer is a Uint8Array with integer accessors but no write(string, offset,
    // encoding); the first camera frame of a call threw there and no video was ever sent.
    const proto = Object.create(Uint8Array.prototype);
    proto.writeUInt32LE = function (value, at) { new DataView(this.buffer, this.byteOffset).setUint32(at, value, true); };
    const wrap = bytes => Object.setPrototypeOf(bytes, proto), real = globalThis.Buffer;
    const simulated = size => wrap(new Uint8Array(size));
    simulated.alloc = simulated;
    simulated.concat = parts => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return wrap(out); };
    globalThis.Buffer = simulated;
    try {
        const framed = RobotMedia.cameraFrame(new Uint8Array(115200), 320, 240), view = new DataView(framed.buffer, framed.byteOffset);
        assert.equal(String.fromCharCode(...framed.subarray(0, 4)), 'JICF');
        assert.equal(view.getUint32(4, true), 320); assert.equal(view.getUint32(8, true), 240);
        assert.equal(framed.length, 12 + 115200);
    } finally { globalThis.Buffer = real; }
});

test('I420 round trip keeps colours, and camera frames carry the JICF header', () => {
    const width = 4, height = 2, rgba = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; ++i) rgba.set([200, 60, 30, 255], i * 4);
    const i420 = RobotMedia.toI420(rgba, width, height), back = new Uint8ClampedArray(rgba.length);
    assert.equal(i420.length, width * height * 3 / 2);
    RobotMedia.fromI420(i420, width, height, back);
    for (let i = 0; i < rgba.length; ++i) assert.ok(Math.abs(back[i] - rgba[i]) <= 6, 'channel ' + i + ': ' + back[i] + ' vs ' + rgba[i]);
    const framed = RobotMedia.cameraFrame(i420, width, height);
    assert.equal(framed.toString('ascii', 0, 4), 'JICF');
    assert.deepEqual([framed.readUInt32LE(4), framed.readUInt32LE(8)], [width, height]);
    assert.ok(framed.slice(12).equals(i420));
});

// Stand-ins for gst-launch children, the helper's pipes and the face's camera preview.
function fakeDevices() {
    const children = [], cameras = [], writes = {3: [], 5: []};
    const stream = () => Object.assign(new EventEmitter(), {writableLength: 0, write: () => true});
    const helper = {stdio: [null, null, null, stream(), stream(), stream(), stream()]};
    for (const fd of [3, 5]) helper.stdio[fd].write = (bytes) => { writes[fd].push(bytes); return true; };
    const spawn = () => {
        const child = Object.assign(new EventEmitter(), {exitCode: null, killed: [], stdout: new EventEmitter(), stderr: new EventEmitter(),
            stdin: Object.assign(new EventEmitter(), {writableLength: 0, write: () => true})});
        child.kill = (signal) => { child.killed.push(signal); if (child.exitCode === null) { child.exitCode = 0; setImmediate(() => { child.emit('exit', 0); child.emit('close', 0); }); } };
        children.push(child); return child;
    };
    const canvas = () => ({width: 0, height: 0, getContext: () => ({drawImage() {}, getImageData: (x, y, w, h) => ({data: new Uint8ClampedArray(w * h * 4)}),
        createImageData: (w, h) => ({data: new Uint8ClampedArray(w * h * 4)}), putImageData() {}})});
    const jibo = {media: {PhotoType: {PREVIEW: 'preview'}, takePhoto: (options, done) => setImmediate(() => done(null, {url: 'preview.jpg'}))},
        loader: {load: (options, done) => setImmediate(() => done(null, Buffer.from('jpeg')))}};
    class Camera extends EventEmitter {
        constructor() { super(); cameras.push(this); this.stopped = 0; }
        start() { this.emit('frame', Buffer.alloc(115200)); return Promise.resolve(); }
        stop() { this.stopped++; return Promise.resolve(); }
    }
    return {children, cameras, camera: Camera, writes, helper, spawn, jibo, canvas};
}
function withBrowserGlobals(canvas, fn) {
    const saved = {document: globalThis.document, Image: globalThis.Image, createObjectURL: URL.createObjectURL, revokeObjectURL: URL.revokeObjectURL};
    globalThis.document = {createElement: canvas};
    globalThis.Image = class { set src(url) { setImmediate(() => this.onload()); } };
    URL.createObjectURL = () => 'blob:fake'; URL.revokeObjectURL = () => {};
    return Promise.resolve().then(fn).finally(() => {
        globalThis.document = saved.document; globalThis.Image = saved.Image;
        URL.createObjectURL = saved.createObjectURL; URL.revokeObjectURL = saved.revokeObjectURL;
    });
}

test('media: a device that fails at once rejects start immediately, not after the timeout', () => {
    const d = fakeDevices();
    return withBrowserGlobals(d.canvas, async () => {
        const media = new RobotMedia(d.jibo, {spawn: d.spawn, camera: d.camera, timeoutMs: 60000});
        let unavailable = 0; media.on('unavailable', () => ++unavailable);
        const started = media.start(d.helper);
        d.children[0].exitCode = 1; d.children[0].emit('exit', 1); d.children[0].emit('close', 1);
        const outcome = await Promise.race([started.then(() => 'started', (e) => e.message), tick(500).then(() => 'still waiting')]);
        assert.equal(outcome, 'media_unavailable');
        assert.equal(unavailable, 1);
        assert.ok(d.children[1].killed.includes('SIGTERM'));
    });
});

test('media: start, framed camera only during a call with the camera on, clean stop', () => {
    const d = fakeDevices();
    return withBrowserGlobals(d.canvas, async () => {
        const media = new RobotMedia(d.jibo, {spawn: d.spawn, camera: d.camera, timeoutMs: 60000});
        const started = media.start(d.helper);
        d.children[0].stdout.emit('data', Buffer.alloc(1920));
        assert.equal(await Promise.race([started, tick(1000).then(() => 'timeout')]), true);
        assert.equal(d.writes[3].length, 0, 'no microphone audio outside a call');
        assert.equal(d.writes[5].length, 0, 'the readiness probe sends no frame');
        media.setCallActive(true); media.setCamera(true);
        await media.cameraTransition;
        assert.equal(d.writes[5].length, 1);
        assert.equal(d.writes[5][0].toString('ascii', 0, 4), 'JICF');
        assert.equal(d.writes[5][0].length, 12 + 320 * 240 * 3 / 2);
        d.children[0].stdout.emit('data', Buffer.alloc(1920));
        assert.equal(d.writes[3].length, 1);
        media.setCallActive(false);
        await media.cameraTransition;
        d.cameras[0].emit('frame', Buffer.alloc(115200));
        assert.equal(d.writes[5].length, 1, 'camera stops with the call');
        assert.ok(d.cameras[0].stopped >= 2, 'probe and camera-off release the native stream');
        await media.stop();
        assert.ok(d.children.every((c) => c.killed.includes('SIGTERM')));
        assert.equal(d.helper.stdio[6].listenerCount('data'), 0);
    });
});

test('media: stop during start rejects at once, and a speaker EPIPE is not uncaught', () => {
    const d = fakeDevices();
    return withBrowserGlobals(d.canvas, async () => {
        const media = new RobotMedia(d.jibo, {spawn: d.spawn, camera: d.camera, timeoutMs: 60000});
        const started = media.start(d.helper);
        media.stop();
        assert.equal(await Promise.race([started.then(() => 'started', (e) => e.message), tick(500).then(() => 'still waiting')]), 'media_closed');
        const again = new RobotMedia(d.jibo, {spawn: d.spawn, camera: d.camera, timeoutMs: 60000});
        let unavailable = 0; again.on('unavailable', () => ++unavailable);
        const second = again.start(d.helper).catch((e) => e.message);
        d.children[3].stdin.emit('error', Object.assign(Error('EPIPE'), {code: 'EPIPE'}));
        assert.equal(unavailable, 1);
        assert.equal(await second, 'media_unavailable');
    });
});

test('supervisor guards the media pipes against EPIPE after the helper exits', () => {
    const stdio = [0, 1, 2, 3, 4, 5, 6].map(() => new EventEmitter());
    const child = Object.assign(new EventEmitter(), {stdio, stdin: Object.assign(stdio[0], {write: () => true, end: () => {}}), stdout: stdio[1], stderr: stdio[2], kill: () => {}});
    const timers = {setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {}};
    const s = new Supervisor({appRoot: '/app', dataRoot: '/data', apiFile: '/data/api.json', stateDir: '/data/account', media: true, timers,
        launch: () => ({command: 'helper', prefix: []}), spawn: () => child});
    s.start();
    for (const fd of [3, 4, 5, 6]) assert.doesNotThrow(() => stdio[fd].emit('error', Error('EPIPE')));
});

// ---- The skill controller (index.js) with stand-ins for the SDK, the helper and devices.
function loadController(data) {
    const Module = require('module'), original = Module._load, supervisors = [], medias = [];
    class FakeSupervisor extends EventEmitter {
        constructor(options) { super(); this.options = options; this.sent = []; this.child = null; supervisors.push(this); }
        start() { this.child = {stdio: []}; return true; }
        send(value) { this.sent.push(value); return true; }
        stop() { const child = this.child; this.child = null; if (child) this.emit('gone'); return Promise.resolve(); }
    }
    class FakeMedia extends EventEmitter {
        constructor() { super(); this.callActive = null; this.camera = null; this.stopped = 0; medias.push(this); }
        start() { return Promise.resolve(true); }
        setCallActive(active) { this.callActive = active; }
        setCamera(enabled) { this.camera = enabled; }
        stop() { ++this.stopped; return Promise.resolve(); }
    }
    const fakes = {jibo: {expression: {}, face: {views: {}}}, '@be/be-framework': {BeSkill: class {}}, './lib/helper': FakeSupervisor, './lib/media': FakeMedia};
    const entry = require.resolve('../telejibo/index.js');
    delete require.cache[entry];
    Module._load = function (request, parent, ...rest) {
        if (parent && parent.filename === entry && request in fakes) return fakes[request];
        return original.call(this, request, parent, ...rest);
    };
    try { return {controller: require(entry).controller, supervisors, medias}; }
    finally { Module._load = original; }
}
function fakeScreen() {
    return {state: 'starting', view: {}, call: null, message: '', password: '', qr: null, renders: [], left: 0, events: [],
        render() { this.renders.push(this.state); }, leave() { ++this.left; }, event(value) { this.events.push(value); }, videoFrame() {}};
}
function openController() {
    const data = temp();
    fs.writeFileSync(path.join(data, 'api.override.json'), JSON.stringify(KEY));
    const loaded = loadController(data), screen = fakeScreen();
    process.env.TELEJIBO_DATA_DIR = data;
    try { loaded.controller.opened(screen); } finally { delete process.env.TELEJIBO_DATA_DIR; }
    if (!loaded.supervisors.length) throw Error("not started: " + screen.state);
    return Object.assign(loaded, {screen, supervisor: loaded.supervisors[0]});
}

test('controller: an override key is copied into the private api.json', () => {
    const {supervisor} = openController();
    assert.equal(path.basename(supervisor.options.apiFile), 'api.json');
    assert.equal(fs.statSync(supervisor.options.apiFile).mode & 0o777, 0o600);
    assert.equal(supervisor.options.media, true);
});

test('controller: media is held only for a call, and hangup stops the camera at once', async () => {
    const {controller, supervisor, medias} = openController();
    await controller.prepareMedia();
    assert.deepEqual(supervisor.sent.at(-1), {method: 'media.ready', enabled: true});
    supervisor.emit('status', {event: 'call', call_id: 5, state: 'callStateReady'});
    assert.equal(medias[0].callActive, true);
    controller.setCamera(true);
    controller.hangup(5);
    assert.equal(medias[0].callActive, false);
    assert.deepEqual(supervisor.sent.at(-1), {method: 'call.hangup', call_id: 5});
    supervisor.emit('status', {event: 'call', call_id: 5, state: 'callStateDiscarded'});
    assert.deepEqual(supervisor.sent.at(-1), {method: 'media.ready', enabled: false});
    assert.equal(medias[0].stopped, 1);
    assert.equal(controller.mediaReady, false);
});

test('controller: closing mid-call releases devices first and does not show a stopped screen', async () => {
    const {controller, supervisor, medias, screen} = openController();
    await controller.prepareMedia();
    supervisor.emit('status', {event: 'call', call_id: 6, state: 'callStateReady'});
    screen.state = 'ready';
    await controller.close();
    assert.equal(medias[0].stopped, 1);
    assert.deepEqual(supervisor.sent.at(-1), {method: 'media.ready', enabled: false});
    assert.equal(screen.state, 'ready');
    assert.equal(screen.left, 0);
});

test('controller: an unexpected helper exit says stopped; after sign-out it says signed out', () => {
    let opened = openController();
    opened.screen.state = 'ready';
    opened.supervisor.emit('gone');
    assert.equal(opened.screen.state, 'stopped');
    assert.equal(opened.screen.left, 1);
    opened = openController();
    opened.screen.state = 'closed';
    opened.supervisor.emit('gone');
    assert.equal(opened.screen.state, 'closed');
});

test('controller retains failed native cleanup and retries it before opening new media', async () => {
    const {controller, medias} = openController();
    await controller.prepareMedia();
    let stops = 0;
    medias[0].stop = () => ++stops === 1 ? Promise.reject(Error('native_stop_failed')) : Promise.resolve();
    await assert.rejects(controller.releaseMedia(), /native_stop_failed/);
    assert.equal(controller.mediaReady, false);
    await controller.prepareMedia();
    assert.equal(stops,2);
    assert.equal(medias.length,2);
    await controller.close();
});
