import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const createScreen = require('../telejibo/lib/screen');
const CallTone = require('../telejibo/lib/call-tone');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
}
function fixture() {
    const ready = deferred(), sent = [], logs = [], tones = [];
    const log = {info() {}, debug() {}, warn(v) { logs.push(v); }, error(v) { logs.push(v); }};
    const jibo = {face: {views: {ActionData: {CALLBACK: 'callback'}}}, sound: {
        add(alias, options) {
            const tone = {alias, options, stopped: 0, removed: 0,
                play(o) { this.loaded = o.loaded; }, stop() { ++this.stopped; }};
            tones.push(tone); return tone;
        },
        remove(alias) { ++tones.find(t => t.alias === alias).removed; }
    }};
    const controller = {microphoneEnabled: false, releases: 0,
        prepareMedia: () => ready.promise,
        releaseMedia() { ++this.releases; return Promise.resolve(); },
        send(v) { sent.push(v); return true; },
        hangup(id) { sent.push({method: 'call.hangup', call_id: id}); },
        setCamera() {}, setTracking: () => Promise.resolve(true)
    };
    const Screen = createScreen(jibo, class {constructor() { this.log = log; }}, controller);
    const screen = new Screen(), components = new Map();
    const config = screen.config(jibo.face.views);
    for (const item of config.componentConfigs) components.set(item.id, {...item, display: {visible: true}});
    screen.view = {getComponentById: id => components.get(id)};
    screen.ensureDecor = () => false; screen.panning = () => {}; screen.ticking = () => {};
    screen.state = 'ready'; screen.page = {users: [{id: 1, name: 'Alex', available: true}], offset: 0, total: 12};
    return {screen, controller, ready, sent, tones, logs, components, jibo};
}
const contact = {id: 1, name: 'Alex', available: true};

test('dialing shows the call screen immediately but waits for decoded-frame readiness before requesting a call', async () => {
    const f = fixture(), dialing = f.screen.dial(contact);
    assert.equal(f.screen.screen, 'incoming');
    assert.equal(f.screen.isInterruptible, false);
    assert.equal(f.components.get('callerName').text, 'Alex');
    assert.equal(f.components.get('cancel').display.visible, true);
    assert.equal(f.tones.length, 1);
    assert.deepEqual(f.sent, []);
    f.ready.resolve(); await dialing;
    assert.deepEqual(f.sent, [{method: 'call.start', user_id: 1}]);
    f.screen.event({event: 'call', call_id: 7, outgoing: true, name: 'Alex', state: 'callStatePending'});
    f.screen.event({event: 'call', call_id: 7, outgoing: true, name: 'Alex', state: 'callStateReady'});
    assert.equal(f.screen.callTone.current, null);
    assert.equal(f.screen.muted, true);
    f.screen.halt();
});

test('cancel during media preparation prevents a late call request and allows another attempt', async () => {
    const f = fixture(), dialing = f.screen.dial(contact);
    f.screen.cancelCall();
    assert.equal(f.screen.screen, 'contacts');
    assert.equal(f.controller.releases, 1);
    f.ready.resolve(); await dialing;
    assert.deepEqual(f.sent, []);
    await f.screen.dial(contact);
    assert.deepEqual(f.sent, [{method: 'call.start', user_id: 1}]);
    f.screen.halt();
});

test('cancel after requesting a call rejects a late outgoing event and blocks a competing dial until disposal', async () => {
    const f = fixture(); f.ready.resolve(); await f.screen.dial(contact);
    f.screen.cancelCall();
    assert.equal(f.screen.dial(contact), undefined);
    f.screen.event({event: 'call', call_id: 8, outgoing: true, state: 'callStatePending'});
    assert.deepEqual(f.sent.at(-1), {method: 'call.hangup', call_id: 8});
    assert.equal(f.screen.call, null);
    f.screen.event({event: 'call', call_id: 8, outgoing: true, state: 'callStateDiscarded'});
    await f.screen.dial(contact);
    assert.equal(f.sent.filter(v => v.method === 'call.start').length, 2);
    f.screen.halt();
});

test('camera preparation failure is logged, stops dialing and returns to contacts without a status overlay', async () => {
    const f = fixture(), dialing = f.screen.dial(contact);
    f.ready.reject(Error('camera_no_frames')); await dialing;
    assert.equal(f.screen.screen, 'contacts');
    assert.equal(f.components.get('message').display.visible, false);
    assert.ok(f.logs.some(v => v.includes('camera_no_frames')));
    assert.equal(f.screen.callTone.current, null);
    assert.equal(f.controller.releases, 1);
    assert.deepEqual(f.sent, []);
    f.screen.halt();
});

test('declining an incoming call during preparation prevents a late accept', async () => {
    const f = fixture(), call = {event: 'call', call_id: 9, outgoing: false, state: 'callStatePending'};
    f.screen.event(call);
    const preparing = f.screen.prepareCall(call, () => f.controller.send({method: 'call.accept', call_id: 9}));
    assert.equal(f.components.get('decline').display.visible, true);
    assert.equal(f.components.get('accept').display.visible, false);
    f.screen.cancelCall(); f.ready.resolve(); await preparing;
    assert.deepEqual(f.sent, [{method: 'call.hangup', call_id: 9}]);
    f.screen.event({...call, state: 'callStateReady'});
    assert.equal(f.screen.callStarted, 0, 'a late answer cannot revive a declined call');
    assert.deepEqual(f.sent.at(-1), {method: 'call.hangup', call_id: 9});
    f.screen.halt();
});

test('close during preparation cancels late completion and a late sound decode cannot resume dialing', async () => {
    const f = fixture(), dialing = f.screen.dial(contact), first = f.tones[0];
    f.screen.halt();
    assert.ok(first.stopped);
    assert.equal(first.removed, 0, 'pending SDK decode must retain its target');
    f.screen.callTone.start();
    first.loaded();
    assert.equal(first.removed, 1);
    assert.equal(f.tones[1].removed, 0, 'old decode cannot remove a new call sound');
    f.screen.halt(); f.tones[1].loaded();
    f.ready.resolve(); await dialing;
    assert.deepEqual(f.sent, []);
});

test('missing stock sound is logged and never prevents call preparation', () => {
    const f = fixture(), tone = new CallTone({sound: {add() { throw Error('missing_asset'); }, remove() {}}}, {warn(v) { f.logs.push(v); }});
    assert.doesNotThrow(() => tone.start());
    assert.equal(tone.current, null);
    assert.ok(f.logs.some(v => v.includes('missing_asset')));
});

test('swiping away shows Closing with the loader and ignores late authorization states without logging out', () => {
    const f = fixture(), exits = [];
    f.screen.exit = options => exits.push(options);
    f.screen.leave();
    assert.equal(f.screen.screen, 'waiting');
    assert.equal(f.components.get('waiting').text, 'Closing…');
    assert.equal(f.components.get('loading').display.visible, true);
    f.screen.event({event: 'authorization', state: 'logging_out'});
    f.screen.event({event: 'signed_out'});
    assert.equal(f.components.get('waiting').text, 'Closing…');
    assert.deepEqual(exits, [{noElementsOfSurprise: true}]);
    assert.deepEqual(f.sent, []);
});

test('close keeps its loader visible throughout cleanup and never requests logout', async () => {
    const f = fixture(), gate = deferred();
    f.controller.close = () => gate.promise;
    Object.assign(f.jibo.face.views, {currentView: f.screen.view, viewStackLength: 2, TRANSITION: {OUT: 'out'},
        changeView(options, done) { done(); }});
    Object.assign(f.screen.view, {state: 'opened'});
    const closed = new Promise((resolve, reject) => f.screen.close(error => error ? reject(error) : resolve()));
    assert.equal(f.screen.state, 'closing');
    assert.equal(f.components.get('waiting').text, 'Closing…');
    assert.equal(f.components.get('loading').display.visible, true);
    f.screen.event({event: 'authorization', state: 'closed'});
    assert.equal(f.components.get('waiting').text, 'Closing…');
    gate.resolve(); await closed;
    assert.deepEqual(f.sent, []);
    assert.equal(f.screen.view, null);
});
