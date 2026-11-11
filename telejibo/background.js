// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// TeleJibo's background script (BEam 3.1.9, `jibo.background` in package.json). BEam
// starts it when Jibo boots and after an install or update, with no screen.
//
// It does something only when the person switched on "Background calls" in TeleJibo's
// settings and has signed in: then it keeps the Telegram helper connected, and when a
// call comes in it asks BEam to open TeleJibo, which shows the caller and rings. The
// camera and microphone are never opened here: they start when the person answers.
// Runs on the robot's Node 6: ES2015 only.
var sessions = require('./lib/session'), Supervisor = require('./lib/helper'), createLog = require('./lib/log');

var RETRY = 2000;                       // ms between attempts to bring the screen up
var SIGN_IN = ['qr', 'password'];       // states that need the person at the screen
var running = null;

exports.start = function (api) {
    if (running) exports.stop();
    var log = createLog(api.log, 'background'), session = sessions.get(), ring = null;
    function quiet() { if (ring !== null) { clearInterval(ring); ring = null; } }
    // BEam does not say whether it let the switch happen (an alarm or setup screen wins),
    // so ask again while the call still rings and our screen is not up.
    function show(call) {
        if (ring !== null) return;
        function attempt() {
            var current = session.call;
            if (!current || current.call_id !== call.call_id || current.state !== 'callStatePending' || api.isOpen()) { quiet(); return; }
            api.open({call_id: call.call_id});
        }
        log.info('incoming call: opening TeleJibo');
        attempt();
        if (session.call && !api.isOpen()) ring = setInterval(attempt, RETRY);
    }
    var listener = {
        status: function (value) {
            if (value.event === 'authorization' && SIGN_IN.indexOf(value.state) >= 0 && !session.screen()) {
                // Signing in needs the screen; nothing to wait for until the person opens TeleJibo.
                log.info('not signed in; background calls are off until TeleJibo is opened');
                session.stop();
            }
            if (value.event !== 'call') return;
            var call = session.call;
            if (call && !call.outgoing && call.state === 'callStatePending' && !session.screen()) show(call); else quiet();
        },
        gone: quiet
    };
    running = {session: session, listener: listener, quiet: quiet};
    session.attach(listener);
    try { session.load(); }
    catch (error) { log.warn('settings unavailable:', error && (error.code || error.message)); return; }
    if (!session.settings.background) { log.info('background calls are off'); return; }
    if (!session.hasAccount()) { log.info('nobody has signed in yet'); return; }
    log.info('background calls are on: keeping Telegram connected');
    session.start({appRoot: api.rootPath, Supervisor: Supervisor, log: api.log});
};

// The skill is being removed or replaced by a new version: nothing of this one may stay.
exports.stop = function () {
    var current = running; running = null;
    if (!current) return;
    current.quiet();
    current.session.detach(current.listener);
    current.session.stop();
    sessions.discard();
};
