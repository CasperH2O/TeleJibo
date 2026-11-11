// SPDX-License-Identifier: GPL-3.0-or-later
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const voice = require('../telejibo/lib/voice');
const createScreen = require('../telejibo/lib/screen');

test('voice: the name after "call" is who to call; launches without a name have none', () => {
    const cases = {
        'Hey Jibo, video call Anna': 'anna', 'make a video call to Anna Lee please': 'anna lee', 'telejibo call my mum': 'mum',
        'video call Zoë on Telegram': 'zoë', 'open telejibo': '', 'video call': '', 'make a video call': '', 'video call someone': '',
        'call me': '', '': ''
    };
    for (const [said, name] of Object.entries(cases)) assert.equal(voice.callee(said), name, said);
    assert.equal(voice.callee(undefined), '');
});

test('voice: the best callable contact wins; a tie or an uncallable contact is no match', () => {
    const contacts = [{id: 1, name: 'Anna Lee', available: true}, {id: 2, name: 'Annabel Ross', available: true},
        {id: 3, name: 'Bob', available: false}, {id: 4, name: 'Chris Park', available: true}, {id: 5, name: 'Chris Young', available: true}];
    assert.equal(voice.match('anna lee', contacts).contact.id, 1);
    assert.equal(voice.match('anna', contacts).contact.id, 1, 'a whole first name beats a longer name that starts with it');
    assert.equal(voice.match('annab', contacts).contact.id, 2);
    assert.equal(voice.match('bob', contacts), null);
    assert.equal(voice.match('chris', contacts).certain, false);
    assert.equal(voice.match('dora', contacts), null);
    assert.equal(voice.match('an', contacts), null, 'two letters are not a name');
});

test('voice: yes and no in their spoken forms; a refusal wins', () => {
    for (const said of ['Yes', 'yeah, call', 'OK!', 'answer it', 'pick up']) assert.equal(voice.decision(said), 'yes', said);
    for (const said of ['no', 'Cancel.', 'never mind', "no, don't answer", 'decline', 'hang up']) assert.equal(voice.decision(said), 'no', said);
    for (const said of ['', 'what time is it', 'maybe', 'know']) assert.equal(voice.decision(said), null, said);
});

// Jibo's speech turns, answered by the test.
function speech() {
    const turns = [];
    const jibo = {privacyController: {enabled: false}, embodied: {listen: {disabled: 0, disableOnce() { ++this.disabled; }}},
        jetstream: {types: {TurnResultType: {INTERRUPTED: 'interrupted', CANCELED: 'canceled', SUCCEEDED: 'ok'}}, startLocalTurn(options) {
            const turn = {options, canceled: 0, cancel() { ++this.canceled; }};
            turn.promise = new Promise(resolve => { turn.say = text => resolve({status: 'ok', result: {asr: {text}}}); turn.end = status => resolve({status}); });
            turns.push(turn); return Promise.resolve(turn);
        }}};
    return {jibo, turns};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('voice: the listener takes turns until an answer is heard, and stop cancels the turn in progress', async () => {
    const s = speech(), listener = new voice.Listener(s.jibo), heard = [];
    assert.equal(listener.start(text => { heard.push(text); return text === 'yes'; }), true);
    await tick();
    assert.deepEqual(s.turns[0].options.nluRules, ['agent/conversation']);
    assert.equal(s.turns[0].options.ignoreGlobalRules, true);
    s.turns[0].say('hmm'); await tick(); await tick();
    assert.equal(s.turns.length, 2, 'not an answer: listen again');
    s.turns[1].say('yes'); await tick(); await tick();
    assert.deepEqual(heard, ['hmm', 'yes']); assert.equal(s.turns.length, 2); assert.equal(listener.active(), false);
    listener.start(() => false); await tick();
    listener.stop(); assert.equal(s.turns[2].canceled, 1);
    s.turns[2].say('yes'); await tick(); assert.equal(s.turns.length, 3);
    // "Hey Jibo" interrupting ends it; privacy mode or a robot without speech turns never starts.
    listener.start(() => false); await tick(); s.turns[3].end('interrupted'); await tick(); await tick();
    assert.equal(s.turns.length, 4); assert.equal(listener.active(), false);
    s.jibo.privacyController.enabled = true; assert.equal(listener.start(() => true), false);
    assert.equal(new voice.Listener({}).start(() => true), false);
});

// staged: like the real helper, each page comes first without names (complete: false), then complete.
// failing: every contacts request fails.
function screenFixture(pages, {staged = false, failing = false} = {}) {
    const s = speech(), sent = [];
    const jibo = Object.assign(s.jibo, {face: {views: {ActionData: {CALLBACK: 'callback'}}}, sound: {add: () => ({play() {}, stop() {}}), remove() {}}});
    const log = {info() {}, debug() {}, warn() {}, error() {}};
    const controller = {settings: {background: false, orientation: 'auto', diagnostics: false}, setSetting() {},
        prepareMedia: () => Promise.resolve(), releaseMedia: () => Promise.resolve(),
        send(value) {
            sent.push(value);
            if (value.method !== 'contacts') return true;
            const page = {event: 'contacts', offset: value.offset, total: pages.length * 6}, users = pages[value.offset / 6] || [];
            if (failing) setImmediate(() => screen.event({event: 'error', reason: 'telegram_request_failed', operation: 'internal'}));
            else if (!staged) setImmediate(() => screen.event({...page, users}));
            else {
                setImmediate(() => screen.event({...page, complete: false, users: users.map(u => ({id: u.id, name: '', available: false}))}));
                setTimeout(() => screen.event({...page, complete: true, users}), 5);
            }
            return true;
        },
        hangup(id) { sent.push({method: 'call.hangup', call_id: id}); }, setCamera() {}, setTracking: () => Promise.resolve(true)};
    const Screen = createScreen(jibo, class {constructor() { this.log = log; }}, controller);
    const screen = new Screen(), components = new Map();
    for (const item of screen.config(jibo.face.views).componentConfigs) components.set(item.id, {...item, display: {visible: true}});
    screen.view = {getComponentById: id => components.get(id)};
    screen.ensureDecor = () => false; screen.panning = () => {}; screen.ticking = () => {}; screen.active = () => true;
    return {screen, sent, components, turns: s.turns};
}
const person = (id, name, available = true) => ({id, name, available});
const settle = async () => { for (let i = 0; i < 6; ++i) await tick(); };

test('screen: "video call Anna" finds her on a later page, asks first, and calls only after a spoken yes', async () => {
    const f = screenFixture([[person(1, 'Bob'), person(2, 'Carl')], [person(3, 'Anna Lee'), person(4, 'Dave')]]);
    f.screen.spoken = 'anna';
    f.screen.event({event: 'authorization', state: 'ready'});
    assert.equal(f.screen.screen, 'waiting');
    await settle();
    assert.deepEqual(f.sent.filter(v => v.method === 'contacts').map(v => v.offset), [0, 6, 0], 'both pages, then back to the first');
    assert.equal(f.screen.confirm.id, 3);
    assert.equal(f.screen.screen, 'incoming');
    assert.equal(f.components.get('callerName').text, 'Anna Lee');
    assert.equal(f.components.get('callerSub').text, 'Video call?');
    assert.equal(f.components.get('accept-text').text, 'Call'); assert.equal(f.components.get('decline-text').text, 'Cancel');
    assert.equal(f.sent.filter(v => v.method === 'call.start').length, 0, 'nothing is dialled yet');
    assert.equal(f.turns.length, 1, 'listening for the answer');
    f.turns[0].say('yes please'); await settle();
    assert.deepEqual(f.sent.filter(v => v.method === 'call.start'), [{method: 'call.start', user_id: 3}]);
    assert.equal(f.screen.confirm, null);
    f.screen.halt();
});

test('screen: a spoken no, or the Cancel button, drops the question; an unknown or ambiguous name says so on the contacts screen', async () => {
    const f = screenFixture([[person(1, 'Anna Lee'), person(2, 'Chris Park'), person(3, 'Chris Young')]]);
    f.screen.spoken = 'anna'; f.screen.event({event: 'authorization', state: 'ready'}); await settle();
    assert.equal(f.screen.screen, 'incoming');
    f.turns[0].say('no'); await settle();
    assert.equal(f.screen.confirm, null); assert.equal(f.screen.screen, 'contacts');
    assert.equal(f.sent.filter(v => v.method === 'call.start').length, 0);
    for (const name of ['chris', 'dora']) {
        f.screen.spoken = name; f.screen.event({event: 'contacts', offset: 0, total: 3, users: f.screen.page.users});
        assert.equal(f.screen.confirm, null); assert.equal(f.screen.screen, 'contacts');
        assert.equal(f.components.get('message').text, 'No contact called ' + name);
        assert.equal(f.components.get('message').display.visible, true);
    }
    f.screen.halt();
});

test("screen: a search by name waits for each page's names, as the real helper sends them late", async () => {
    const f = screenFixture([[person(1, 'Bob'), person(2, 'Carl')], [person(3, 'Anna Lee'), person(4, 'Dave')]], {staged: true});
    f.screen.spoken = 'anna'; f.screen.event({event: 'authorization', state: 'ready'});
    for (let i = 0; i < 10 && !f.screen.confirm; ++i) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(f.sent.filter(v => v.method === 'contacts').map(v => v.offset), [0, 6, 0], 'each page once, then back to the first');
    assert.equal(f.screen.confirm && f.screen.confirm.id, 3);
    assert.equal(f.screen.screen, 'incoming');
    f.screen.halt();
});

test('screen: a contacts page that fails ends a search by name instead of waiting for good', async () => {
    const f = screenFixture([[person(1, 'Anna')]], {failing: true});
    f.screen.spoken = 'anna'; f.screen.event({event: 'authorization', state: 'ready'});
    assert.equal(f.screen.screen, 'waiting');
    await settle();
    assert.equal(f.screen.search, null); assert.equal(f.screen.spoken, '');
    assert.equal(f.screen.screen, 'contacts');
    assert.equal(f.components.get('message').text, 'Please try again');
    f.screen.halt();
});

test('screen: a ringing call can be answered or declined by voice, and listening stops when the ringing does', async () => {
    const ringing = {event: 'call', call_id: 7, state: 'callStatePending', outgoing: false, user_id: 1, name: 'Anna'};
    const f = screenFixture([[person(1, 'Anna')]]);
    f.screen.state = 'ready'; f.screen.event(ringing);
    assert.equal(f.screen.listening, 'ring'); await settle();
    f.turns[0].say('answer'); await settle();
    assert.deepEqual(f.sent.at(-1), {method: 'call.accept', call_id: 7});
    f.screen.event({event: 'call', call_id: 7, state: 'callStateDiscarded'});
    assert.equal(f.screen.listening, null);

    f.screen.event({...ringing, call_id: 8}); await settle();
    const turn = f.turns.at(-1); turn.say('decline'); await settle();
    assert.deepEqual(f.sent.at(-1), {method: 'call.hangup', call_id: 8});
    f.screen.event({event: 'call', call_id: 8, state: 'callStateDiscarded'});
    f.screen.event({...ringing, call_id: 9}); await settle();
    const last = f.turns.at(-1);
    f.screen.event({event: 'call', call_id: 9, state: 'callStateDiscarded'});
    assert.equal(last.canceled, 1, 'no listening once the call is gone');
    f.screen.halt();
});
