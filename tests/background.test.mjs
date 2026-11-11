// SPDX-License-Identifier: GPL-3.0-or-later
// The shared helper session and the background script, with a stand-in helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const sessions = require('../telejibo/lib/session.js');
const settings = require('../telejibo/lib/settings.js');
const KEY = {api_id: 123456, api_hash: '0123456789abcdef0123456789abcdef'};

// A data folder with the app key; optionally signed in before, with Background calls on.
function world({background = false, account = false} = {}) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'telejibo-bg-'));
    fs.writeFileSync(path.join(data, 'api.override.json'), JSON.stringify(KEY));
    if (account) { fs.mkdirSync(path.join(data, 'account')); fs.writeFileSync(path.join(data, 'account', 'td.binlog'), 'x'); }
    settings.write(data, {background});
    const supervisors = [];
    class Supervisor extends EventEmitter {
        constructor(options) { super(); this.options = options; this.sent = []; this.child = null; this.stops = 0; supervisors.push(this); }
        start() { this.child = {stdio: []}; return true; }
        send(value) { this.sent.push(value); return true; }
        stop() { ++this.stops; const child = this.child; this.child = null; if (child) this.emit('gone'); return Promise.resolve(); }
    }
    const opened = [];
    const api = {rootPath: path.resolve(import.meta.dirname, '../telejibo'), skillId: '@be/telejibo', open: false,
        log: {info() {}, warn() {}, error() {}}, isOpen() { return this.open; }, isIdle: () => true,
        open_(data) { opened.push(data); return true; }};
    api.open = api.open_; api.isOpen = () => api.showing === true;
    sessions.discard();
    process.env.TELEJIBO_DATA_DIR = data;
    return {data, supervisors, Supervisor, api, opened, done() { delete process.env.TELEJIBO_DATA_DIR; sessions.discard(); fs.rmSync(data, {recursive: true, force: true}); }};
}
// background.js with the stand-in helper in place of the real one.
function loadBackground(w) {
    const Module = require('module'), original = Module._load, entry = require.resolve('../telejibo/background.js');
    delete require.cache[entry];
    Module._load = function (request, parent, ...rest) {
        if (parent && parent.filename === entry && request === './lib/helper') return w.Supervisor;
        return original.call(this, request, parent, ...rest);
    };
    try { return require(entry); } finally { Module._load = original; }
}
const ready = {event: 'authorization', state: 'ready'};
const ringing = {event: 'call', call_id: 9, state: 'callStatePending', outgoing: false, user_id: 4, name: 'Zoe', is_video: true};

test('session: one helper for everyone; a listener that joins late learns the sign-in state and the ringing call', () => {
    const w = world();
    try {
        const session = sessions.get(), seen = [];
        assert.equal(session.start({appRoot: w.api.rootPath, Supervisor: w.Supervisor}), 'running');
        assert.equal(session.start({appRoot: w.api.rootPath, Supervisor: w.Supervisor}), 'running');
        assert.equal(w.supervisors.length, 1);
        assert.equal(path.basename(w.supervisors[0].options.stateDir), 'account');
        w.supervisors[0].emit('status', ready); w.supervisors[0].emit('status', ringing);
        w.supervisors[0].emit('status', {event: 'call', call_id: 9, state: 'callStatePending', emojis: ['a']});
        session.attach({status: value => seen.push(value)});
        assert.deepEqual(seen.map(v => v.event), ['authorization', 'call']);
        assert.equal(seen[1].name, 'Zoe', 'later updates keep who is calling');
        assert.equal(sessions.get(), session);
    } finally { w.done(); }
});

test('session: the helper is kept after the screen only when asked to and signed in', async () => {
    const w = world({background: true});
    try {
        const session = sessions.get(); session.load();
        session.start({appRoot: w.api.rootPath, Supervisor: w.Supervisor});
        assert.equal(session.keeps(), false, 'not signed in yet');
        w.supervisors[0].emit('status', ready);
        assert.equal(session.keeps(), true);
        session.setSetting('background', false);
        assert.equal(session.keeps(), false);
        assert.equal(settings.read(w.data).background, false, 'the choice is saved');
        await session.stop();
        assert.equal(session.running(), false); assert.equal(session.authorization, null);
    } finally { w.done(); }
});

test('session: a call that rang with no screen is remembered once; an answered or outgoing one is not', () => {
    const w = world();
    try {
        const session = sessions.get();
        session.start({appRoot: w.api.rootPath, Supervisor: w.Supervisor});
        const helper = w.supervisors[0];
        helper.emit('status', ringing); helper.emit('status', {event: 'call', call_id: 9, state: 'callStateDiscarded'});
        const missed = session.takeMissed();
        assert.equal(missed.name, 'Zoe'); assert.equal(missed.user_id, 4);
        assert.equal(session.takeMissed(), null);
        const screen = {screen: true, status() {}}; session.attach(screen);
        helper.emit('status', {...ringing, call_id: 10}); helper.emit('status', {event: 'call', call_id: 10, state: 'callStateDiscarded'});
        assert.equal(session.takeMissed(), null, 'the screen showed it');
        session.detach(screen);
        helper.emit('status', {...ringing, call_id: 11}); helper.emit('status', {event: 'call', call_id: 11, state: 'callStateReady'});
        helper.emit('status', {event: 'call', call_id: 11, state: 'callStateDiscarded'});
        helper.emit('status', {...ringing, call_id: 12, outgoing: true}); helper.emit('status', {event: 'call', call_id: 12, state: 'callStateDiscarded'});
        assert.equal(session.takeMissed(), null);
    } finally { w.done(); }
});

test('background: does nothing when the setting is off or nobody has signed in', () => {
    for (const options of [{background: false, account: true}, {background: true, account: false}]) {
        const w = world(options);
        try {
            const background = loadBackground(w);
            background.start(w.api);
            assert.equal(w.supervisors.length, 0);
            background.stop();
        } finally { w.done(); }
    }
});

test('background: keeps Telegram connected, opens TeleJibo for an incoming call and retries until it shows or the call ends', async (t) => {
    t.mock.timers.enable({apis: ['setInterval']});
    const w = world({background: true, account: true});
    try {
        const background = loadBackground(w);
        background.start(w.api);
        assert.equal(w.supervisors.length, 1);
        assert.equal(w.supervisors[0].options.media, true);
        const helper = w.supervisors[0];
        helper.emit('status', ready); helper.emit('status', ringing);
        assert.deepEqual(w.opened, [{call_id: 9}]);
        t.mock.timers.tick(2000); assert.equal(w.opened.length, 2, 'BEam may have refused the first switch');
        w.api.showing = true; t.mock.timers.tick(2000);
        assert.equal(w.opened.length, 2, 'the screen is up');
        t.mock.timers.tick(10000); assert.equal(w.opened.length, 2);
        // The next call ends before the screen ever shows.
        w.api.showing = false;
        helper.emit('status', {...ringing, call_id: 10}); assert.equal(w.opened.length, 3);
        helper.emit('status', {event: 'call', call_id: 10, state: 'callStateDiscarded'});
        t.mock.timers.tick(10000); assert.equal(w.opened.length, 3);
        assert.equal(sessions.get().takeMissed().name, 'Zoe');
        // An outgoing call, or one the open screen already shows, is not ours to open.
        helper.emit('status', {...ringing, call_id: 11, outgoing: true});
        const screen = {screen: true, status() {}}; sessions.get().attach(screen);
        helper.emit('status', {...ringing, call_id: 12});
        assert.equal(w.opened.length, 3);
        background.stop();
        assert.equal(helper.stops, 1, 'an update or removal ends the helper');
        assert.notEqual(sessions.get().supervisor, helper);
    } finally { w.done(); }
});

test('background: a helper that needs sign-in is stopped unless the screen is there to show it', () => {
    const w = world({background: true, account: true});
    try {
        const background = loadBackground(w);
        background.start(w.api);
        w.supervisors[0].emit('status', {event: 'authorization', state: 'qr', link: 'tg://login'});
        assert.equal(w.supervisors[0].stops, 1);
        background.stop();
    } finally { w.done(); }
});

test('background: a helper that stops by itself is started again, less often each time; not after sign-in is needed', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
    const w = world({background: true, account: true});
    try {
        const background = loadBackground(w);
        background.start(w.api);
        const crash = helper => { helper.child = null; helper.emit('gone'); };
        w.supervisors[0].emit('status', ready);
        crash(w.supervisors[0]);
        t.mock.timers.tick(4000); assert.equal(w.supervisors.length, 1, 'not at once');
        t.mock.timers.tick(1000); assert.equal(w.supervisors.length, 2);
        crash(w.supervisors[1]);
        t.mock.timers.tick(5000); assert.equal(w.supervisors.length, 2, 'the second restart waits longer');
        t.mock.timers.tick(25000); assert.equal(w.supervisors.length, 3);
        // Signed in again: the wait starts over. A screen that is up owns the helper.
        w.supervisors[2].emit('status', ready);
        const screen = {screen: true, status() {}}; sessions.get().attach(screen);
        crash(w.supervisors[2]);
        t.mock.timers.tick(5000); assert.equal(w.supervisors.length, 3, 'the screen is up');
        sessions.get().detach(screen);
        t.mock.timers.tick(5000); assert.equal(w.supervisors.length, 4, 'started again once the screen has closed');
        // A helper that needs sign-in is stopped on purpose, and stays stopped.
        w.supervisors[3].emit('status', {event: 'authorization', state: 'qr', link: 'tg://login'});
        t.mock.timers.tick(600000); assert.equal(w.supervisors.length, 4);
        background.stop();
    } finally { w.done(); }
});

test('background: nothing is started again with Background calls off, or after the skill is stopped', (t) => {
    t.mock.timers.enable({apis: ['setTimeout', 'setInterval']});
    const w = world({background: true, account: true});
    try {
        const background = loadBackground(w);
        background.start(w.api);
        w.supervisors[0].emit('status', ready);
        sessions.get().setSetting('background', false);
        w.supervisors[0].child = null; w.supervisors[0].emit('gone');
        t.mock.timers.tick(600000); assert.equal(w.supervisors.length, 1);
        sessions.get().setSetting('background', true);
        background.start(w.api);
        assert.equal(w.supervisors.length, 2);
        w.supervisors[1].child = null; w.supervisors[1].emit('gone');
        background.stop();
        t.mock.timers.tick(600000); assert.equal(w.supervisors.length, 2);
    } finally { w.done(); }
});
