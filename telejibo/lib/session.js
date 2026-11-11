// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The one Telegram helper, shared by the skill's screen (index.js) and its background
// script (background.js). Whoever needs it first starts it; the screen and the background
// script listen to the same events. With "Background calls" on, the helper stays signed
// in after the screen closes, so a call can ring while TeleJibo is closed.
//
// BEam loads both parts into its own process, but may reload the skill's modules from
// disk, so the session lives on the process-wide object rather than in this module.
// Runs on the robot's Node 6: ES2015 only.
var path = require('path'), fs = require('fs');
var paths = require('./paths'), credentials = require('./credentials'), settings = require('./settings'), createLog = require('./log');

var root = typeof global !== 'undefined' ? global : window, KEY = '__telejiboSession';
var ENDED = ['callStateDiscarded', 'callStateError'];

function create() {
    var session = {
        supervisor: null, listeners: [], log: createLog(null, 'session'),
        dataRoot: null, settings: settings.clean(),
        // The last sign-in state and the call in progress, for a listener that joins late.
        authorization: null, call: null, answered: false,
        // A call that rang while nothing could show it: {user_id, name, at}.
        missed: null,
        running: function () { return !!(this.supervisor && this.supervisor.child); },
        // Reads the person's choices and prepares the private data folder.
        load: function () {
            this.dataRoot = paths.ensureDirectory(paths.dataRoot());
            this.settings = settings.read(this.dataRoot);
            return this.settings;
        },
        setSetting: function (name, value) {
            var next = Object.assign({}, this.settings); next[name] = value;
            this.settings = settings.clean(next);
            try { if (this.dataRoot) settings.write(this.dataRoot, this.settings); }
            catch (error) { this.log.error('settings could not be saved:', error && (error.code || error.message)); }
            this.log.info('setting', name, '->', this.settings[name]);
            return this.settings;
        },
        // Has someone signed in on this robot before? The helper keeps its account here.
        hasAccount: function () {
            try { return !!this.dataRoot && fs.readdirSync(path.join(this.dataRoot, 'account')).length > 0; } catch (_) { return false; }
        },
        // Starts the helper unless it runs already. options: appRoot, Supervisor, log.
        // Returns 'running', or 'setup' when the app's Telegram key is missing.
        start: function (options) {
            if (this.running()) return 'running';
            var self = this, apiFile;
            if (!this.dataRoot) this.load();
            try { apiFile = credentials.apiFile(options.appRoot, this.dataRoot); }
            catch (error) { apiFile = null; this.log.error('sign-in setup unavailable:', error && (error.code || error.message)); }
            if (!apiFile) return 'setup';
            var supervisor = this.supervisor = new options.Supervisor({appRoot: options.appRoot, dataRoot: this.dataRoot, apiFile: apiFile,
                stateDir: path.join(this.dataRoot, 'account'), media: true, log: options.log});
            this.authorization = null; this.call = null; this.answered = false;
            supervisor.on('status', function (value) { if (self.supervisor === supervisor) self.status(value); });
            supervisor.on('failure', function (reason) { if (self.supervisor === supervisor) self.each('failure', reason); });
            supervisor.on('gone', function () {
                if (self.supervisor !== supervisor) return;
                self.supervisor = null; self.authorization = null; self.call = null;
                self.each('gone');
            });
            if (!supervisor.start()) { if (this.supervisor === supervisor) this.supervisor = null; return 'failed'; }
            return 'running';
        },
        status: function (value) {
            if (value.event === 'authorization') this.authorization = value;
            else if (value.event === 'signed_out') this.authorization = null;
            else if (value.event === 'call') {
                var ended = ENDED.indexOf(value.state) >= 0, previous = this.call;
                if (value.state === 'callStateReady') this.answered = true;
                if (!previous || previous.call_id !== value.call_id) this.answered = value.state === 'callStateReady';
                if (ended) {
                    // It rang and nobody could see it: no screen was listening when it ended.
                    var rang = previous && previous.call_id === value.call_id ? previous : value;
                    if (!rang.outgoing && !this.answered && !this.screen()) this.missed = {user_id: rang.user_id, name: rang.name || '', at: Date.now()};
                    this.call = null; this.answered = false;
                } else this.call = Object.assign({}, previous && previous.call_id === value.call_id ? previous : {}, value);
            }
            this.each('status', value);
        },
        each: function (name, value) {
            this.listeners.slice().forEach(function (listener) {
                if (typeof listener[name] !== 'function') return;
                try { listener[name](value); } catch (error) { session.log.error('listener failed:', error && (error.message || error)); }
            });
        },
        screen: function () { return this.listeners.filter(function (listener) { return listener.screen; })[0] || null; },
        // listener: {status(value), failure(reason), gone(), screen: true for the skill's view}.
        // It is told at once where sign-in stands and of a call in progress.
        attach: function (listener) {
            if (this.listeners.indexOf(listener) < 0) this.listeners.push(listener);
            if (typeof listener.status !== 'function') return;
            if (this.authorization) listener.status(this.authorization);
            if (this.call) listener.status(this.call);
        },
        detach: function (listener) {
            var at = this.listeners.indexOf(listener);
            if (at >= 0) this.listeners.splice(at, 1);
        },
        send: function (value) { return !!this.supervisor && this.supervisor.send(value); },
        // The helper may stay for calls only while signed in and asked to.
        keeps: function () {
            return !!this.settings.background && this.running() && !!this.authorization && this.authorization.state === 'ready';
        },
        stop: function () {
            var supervisor = this.supervisor;
            return Promise.resolve(supervisor ? supervisor.stop() : null);
        },
        takeMissed: function () { var missed = this.missed; this.missed = null; return missed; }
    };
    return session;
}

// The session of this process; `fresh` (tests, a skill update) replaces it.
function get(fresh) {
    if (fresh || !root[KEY]) root[KEY] = create();
    return root[KEY];
}
function discard() { delete root[KEY]; }

module.exports = {get: get, discard: discard, create: create, KEY: KEY};
