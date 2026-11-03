// Unit tests for TeleJibo's pure parts: layout rules, the app key, helper launch and packaging.
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

test('apiFile writes the bundled key privately, and an override wins', () => {
    const app = temp(), data = temp();
    assert.equal(credentials.apiFile(app, data), null);
    fs.mkdirSync(path.join(app, 'config'));
    fs.writeFileSync(path.join(app, 'config/app-key.bin'), credentials.encode(KEY));
    const file = credentials.apiFile(app, data);
    assert.equal(file, path.join(data, 'api.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), KEY);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const own = {api_id: 7, api_hash: 'ffffffffffffffffffffffffffffffff'};
    fs.writeFileSync(path.join(data, 'api.override.json'), JSON.stringify(own));
    assert.equal(credentials.apiFile(app, data), path.join(data, 'api.override.json'));
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
