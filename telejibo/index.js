// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// TeleJibo: one-to-one Telegram video calls on Jibo, as a BEam custom skill. This module
// wires the face UI (lib/screen.js) to the Telegram helper (lib/helper.js) and the robot's
// devices (lib/media.js). The helper runs only while the skill is open.
var path = require('path');
var jibo = require('jibo'), BeSkill = require('@be/be-framework').BeSkill;
var Supervisor = require('./lib/helper'), RobotMedia = require('./lib/media'), credentials = require('./lib/credentials');
var paths = require('./lib/paths'), layout = require('./lib/layout'), createScreen = require('./lib/screen');

var appRoot = __dirname;
var supervisor = null, skill = null, media = null, mediaStarting = null, tracking = null, closePromise = null;
var unhook = [];

// Jibo's own head tracking. The attention service keeps a stack where the newest mode wins;
// the face pushes OFF for a handled tap, so ours goes after the tap.
function setTracking(enabled) {
    var expression = jibo.expression;
    if (!enabled) {
        var held = tracking; tracking = null;
        if (!held) return Promise.resolve(false);
        return held.then(function (handle) { return handle.release(); }).catch(function () {}).then(function () { return false; });
    }
    if (tracking) return tracking.then(function () { return true; }, function () { return false; });
    if (!expression || typeof expression.pushAttentionMode !== 'function') return Promise.resolve(false);
    var mode = expression.AttentionMode && expression.AttentionMode.ENGAGED || 'ENGAGED';
    var pushed = tracking = new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () { return expression.pushAttentionMode(mode); });
    return pushed.then(function () { return true; }, function () { if (tracking === pushed) tracking = null; return false; });
}
// Camera, microphone and speaker are held only for a call; Jibo's own listening needs
// the microphone the rest of the time.
function releaseMedia() {
    var current = media;
    media = null; mediaStarting = null;
    if (controller.mediaReady && supervisor) supervisor.send({method: 'media.ready', enabled: false});
    controller.mediaReady = false;
    // A device child that outlives SIGKILL cannot be helped here; teardown goes on.
    return Promise.resolve(current ? current.stop() : null).catch(function () {});
}
function prepareMedia() {
    if (controller.mediaReady) return Promise.resolve();
    if (mediaStarting) return mediaStarting;
    if (!supervisor || !supervisor.child) return Promise.reject(Error('media_unavailable'));
    var current = media = new RobotMedia(jibo);
    current.on('video', function (canvas) { if (skill) skill.videoFrame(canvas); });
    current.on('unavailable', function () {
        if (media !== current) return;
        releaseMedia();
        if (skill) { skill.message = layout.text.mediaStopped; skill.render(); }
    });
    mediaStarting = current.start(supervisor.child).then(function () {
        if (media !== current) throw Error('media_closed');
        mediaStarting = null; controller.mediaReady = true;
        supervisor.send({method: 'media.ready', enabled: true});
    }, function (error) {
        if (media === current) { media = null; mediaStarting = null; }
        throw error;
    });
    return mediaStarting;
}
function unbind() { unhook.splice(0).forEach(function (off) { try { off(); } catch (_) {} }); }
function close() {
    if (closePromise) return closePromise;
    setTracking(false); unbind();
    closePromise = releaseMedia().then(function () {
        return supervisor ? supervisor.stop() : null;
    }).then(function () { supervisor = null; closePromise = null; }, function (error) { supervisor = null; closePromise = null; throw error; });
    return closePromise;
}
// A hardware keyboard (the simulator, or one plugged into the robot) can type the password.
function bindKeyboard(screen) {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    var key = function (event) {
        if (!screen.active() || screen.state !== 'password' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.key === 'Enter') { controller.send({method: 'login.password', password: screen.password}); screen.password = ''; }
        else if (event.key === 'Backspace') screen.password = Array.from(screen.password).slice(0, -1).join('');
        else if (typeof event.key === 'string' && Array.from(event.key).length === 1 && Buffer.byteLength(screen.password) < 1000) screen.password += event.key;
        else return;
        event.preventDefault(); screen.render();
    };
    window.addEventListener('keydown', key);
    unhook.push(function () { window.removeEventListener('keydown', key); });
}

var controller = {
    mediaReady: false,
    send: function (value) { return !!supervisor && supervisor.send(value); },
    setCamera: function (enabled) {
        if (media) media.setCamera(enabled);
        return controller.send({method: 'call.camera', enabled: enabled});
    },
    // The view is up: start the helper with the app's Telegram key.
    opened: function (screen) {
        skill = screen;
        var dataRoot, apiFile;
        try {
            dataRoot = paths.ensureDirectory(paths.dataRoot());
            apiFile = credentials.apiFile(appRoot, dataRoot);
        } catch (error) { apiFile = null; console.warn('[telejibo] sign-in setup unavailable:', error && (error.code || error.message)); }
        if (!apiFile) { screen.state = 'setup'; screen.render(); return; }
        supervisor = new Supervisor({appRoot: appRoot, dataRoot: dataRoot, apiFile: apiFile,
            stateDir: path.join(dataRoot, 'account'), media: true});
        supervisor.on('status', function (value) {
            if (media && value.event === 'call') media.setCallActive(value.state === 'callStateReady');
            // A finished or refused call gives the devices back.
            if (value.event === 'call' && ['callStateDiscarded', 'callStateError'].indexOf(value.state) >= 0 ||
                value.event === 'error' && !screen.call && !mediaStarting) releaseMedia();
            screen.event(value);
        });
        supervisor.on('failure', function () {
            screen.message = layout.text.stopped; screen.password = ''; screen.qr = null; screen.render();
            close().then(function () { if (screen.view) screen.leave(); });
        });
        supervisor.on('gone', function () {
            screen.password = ''; screen.qr = null; screen.call = null; screen.state = 'closed'; screen.render();
            if (!closePromise && screen.view) screen.leave();
        });
        bindKeyboard(screen);
        if (!supervisor.start()) return;
    },
    prepareMedia: prepareMedia,
    releaseMedia: releaseMedia,
    close: close,
    setTracking: setTracking
};

var qr = require('./vendor/qrcode');
var TeleJibo = createScreen(jibo, BeSkill, controller, qr);
module.exports = TeleJibo;
module.exports.controller = controller;
