// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// TeleJibo: one-to-one Telegram video calls on Jibo, as a BEam custom skill. This module
// wires the face UI (lib/screen.js) to the Telegram helper (lib/helper.js) and the robot's
// devices (lib/media.js). The helper is shared with the background script (lib/session.js):
// it runs while the skill is open and, with "Background calls" on, stays signed in after.
var path = require('path');
var jibo = require('jibo'), BeSkill = require('@be/be-framework').BeSkill;
var Supervisor = require('./lib/helper'), RobotMedia = require('./lib/media'), credentials = require('./lib/credentials');
var paths = require('./lib/paths'), layout = require('./lib/layout'), createScreen = require('./lib/screen');
var createLog = require('./lib/log'), log = createLog(), settings = require('./lib/settings'), sessions = require('./lib/session');

var appRoot = __dirname;
var session = null, listener = null, skill = null, media = null, mediaStarting = null, mediaReleasing = null, tracking = null, closePromise = null;
var unhook = [];
function helper() { return session && session.supervisor; }

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
    if (!expression || typeof expression.pushAttentionMode !== 'function') {
        log.warn('tracking: jibo.expression.pushAttentionMode is not available here');
        return Promise.resolve(false);
    }
    var mode = expression.AttentionMode && expression.AttentionMode.ENGAGED || 'ENGAGED';
    var pushed = tracking = new Promise(function (resolve) { setTimeout(resolve, 0); }).then(function () { return expression.pushAttentionMode(mode); });
    return pushed.then(function () { log.info('tracking: head tracking is on'); return true; }, function (error) {
        log.warn('tracking: pushAttentionMode failed:', error && (error.code || error.message) || error);
        if (tracking === pushed) tracking = null; return false;
    });
}
// Camera, microphone and speaker are held only for a call; Jibo's own listening needs
// the microphone the rest of the time.
function releaseMedia() {
    if (mediaReleasing) return mediaReleasing;
    var current = media;
    mediaStarting = null;
    if (controller.mediaReady && helper()) helper().send({method: 'media.ready', enabled: false});
    controller.mediaReady = false;
    mediaReleasing = Promise.resolve(current ? current.stop() : null).then(function () {
        if (media === current) media = null;
        mediaReleasing = null;
    }, function (error) {
        // Keep ownership so close or the next preparation can retry native stop.
        mediaReleasing = null;
        log.error('media: cleanup failed; native resources still need release: ' + (error.message || error));
        throw error;
    });
    // Event handlers may initiate release without awaiting it. Close/preparation
    // still receive the original rejection and cannot declare cleanup successful.
    mediaReleasing.catch(function () {});
    return mediaReleasing;
}
function prepareMedia() {
    if (controller.mediaReady) return Promise.resolve();
    if (mediaReleasing) return mediaReleasing.then(prepareMedia);
    if (mediaStarting) return mediaStarting;
    if (media) return releaseMedia().then(prepareMedia);
    var supervisor = helper();
    if (!supervisor || !supervisor.child) { log.error('media: no helper is running, so there is nothing to attach the devices to'); return Promise.reject(Error('media_unavailable')); }
    var current = media = new RobotMedia(jibo, {log: skill && skill.log, captureMicrophone: controller.microphoneEnabled, selfView: controller.settings.selfView});
    current.on('video', function (canvas) { if (skill) skill.videoFrame(canvas); });
    current.on('self', function (canvas) { if (skill && skill.selfFrame) skill.selfFrame(canvas); });
    current.on('unavailable', function () {
        if (media !== current) return;
        releaseMedia();
        if (skill) {
            log.error('call media stopped');
            if (skill.call) controller.hangup(skill.call.call_id);
            skill.render();
        }
    });
    mediaStarting = current.start(supervisor.child).then(function () {
        if (media !== current) throw Error('media_closed');
        mediaStarting = null; controller.mediaReady = true;
        supervisor.send({method: 'media.ready', enabled: true});
    }, function (error) {
        log.error('media: devices not available for this call:', error && (error.code || error.message) || error);
        if (media === current) mediaStarting = null;
        throw error;
    });
    return mediaStarting;
}
function unbind() { unhook.splice(0).forEach(function (off) { try { off(); } catch (_) {} }); }
function close() {
    if (closePromise) return closePromise;
    setTracking(false); unbind();
    closePromise = releaseMedia().then(function () {
        var current = session, mine = listener;
        listener = null;
        if (!current) return null;
        if (mine) current.detach(mine);
        // Background calls: the helper stays signed in for the next call. A call that is
        // ringing or in progress ends with the screen.
        if (current.keeps()) {
            if (current.call) current.send({method: 'call.hangup', call_id: current.call.call_id});
            log.info('closed; Telegram stays connected for background calls');
            return null;
        }
        return current.stop();
    }).then(function () { closePromise = null; }, function (error) { closePromise = null; throw error; });
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

// The robot's own load average (Linux); absent elsewhere.
function loadAverage() {
    try { return require('fs').readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' '); } catch (_) { return 'unknown'; }
}

var controller = {
    mediaReady: false,
    // The person's choices (lib/settings.js); defaults until the data folder has been read.
    settings: settings.clean(),
    setSetting: function (name, value) {
        if (session) controller.settings = session.setSetting(name, value);
        else { var next = Object.assign({}, controller.settings); next[name] = value; controller.settings = settings.clean(next); }
        if (name === 'selfView' && media && media.setSelfView) media.setSelfView(controller.settings.selfView);
    },
    send: function (value) { return !!session && session.send(value); },
    // Camera frames stop with the tap, not when Telegram confirms the call ended.
    hangup: function (callId) {
        if (media) media.setCallActive(false);
        return controller.send({method: 'call.hangup', call_id: callId});
    },
    setCamera: function (enabled) {
        log.info('call: camera ->', enabled ? 'on' : 'off', media ? '' : '(no media devices are open!)');
        if (media) media.setCamera(enabled);
        return controller.send({method: 'call.camera', enabled: enabled});
    },
    // The view is up: start the helper with the app's Telegram key.
    opened: function (screen) {
        skill = screen;
        log = createLog(screen.log);
        log.info('opened');
        session = sessions.get();
        try { controller.settings = session.load(); }
        catch (error) { log.error('data folder unavailable:', error && (error.code || error.message)); screen.state = 'setup'; screen.render(); return; }
        var statsNoted = 0, mine = listener = {
            screen: true,
            status: function (value) {
                // What the helper says about the call: states, errors, and how much video moves.
                if (value.event === 'call') log.info('helper call', value.state || '');
                if (value.event === 'error') log.error('helper error', value.code || value.message || '');
                if (value.event === 'media_stats' && Date.now() - statsNoted > 5000) {
                    statsNoted = Date.now();
                    log.debug('helper media_stats: video in', value.decoded_video_frames, 'frames', value.decoded_width + 'x' + value.decoded_height,
                        'audio in', value.nonzero_audio_frames, 'dropped video/speaker', value.dropped_video_frames + '/' + value.dropped_speaker_frames,
                        'pipe failed mic/speaker/video', !!value.microphone_pipe_failed + '/' + !!value.speaker_pipe_failed + '/' + !!value.video_pipe_failed,
                        '| camera out', value.camera_mode, value.camera_width + 'x' + value.camera_height, value.camera_sent_frames, 'frames sent,',
                        value.camera_waiting_frames, 'waiting,', value.camera_restarts, 'restarts, call wants', Math.round((value.camera_target_bps || 0) / 1000), 'kbit/s');
                    // Load figures, only when asked for in settings.json ("diagnostics": true).
                    if (controller.settings.diagnostics) log.info('diagnostics: helper cpu', value.cpu_seconds, 's, memory', value.maxrss_kib, 'KiB, system load', loadAverage());
                }
                if (media && !media.closed && value.event === 'call') media.setCallActive(value.state === 'callStateReady');
                // Between the helper and the camera; the screen has no part in it.
                if (value.event === 'camera') { if (media && value.state === 'restart') media.restartCamera(); return; }
                // A finished or refused call gives the devices back.
                if (value.event === 'call' && ['callStateDiscarded', 'callStateError'].indexOf(value.state) >= 0 ||
                    value.event === 'error' && !screen.call && !mediaStarting) releaseMedia();
                screen.event(value);
            },
            failure: function () {
                screen.message = layout.text.stopped; screen.password = ''; screen.qr = null; screen.render();
                close().then(function () { if (screen.view) screen.leave(); });
            },
            gone: function () {
                // A close we asked for stops the helper too; its exit is no news then.
                if (closePromise || listener !== mine) return;
                // Signed out (the helper said so) or stopped unexpectedly.
                screen.password = ''; screen.qr = null; screen.call = null;
                if (screen.state !== 'closed') screen.state = 'stopped';
                screen.render();
                if (screen.view) screen.leave();
            }
        };
        // A call that rang while TeleJibo could not show it.
        screen.missed = session.takeMissed();
        // If the background script already runs the helper, this tells the screen at once
        // where sign-in stands and of a call that is ringing.
        session.attach(mine);
        var started = session.start({appRoot: appRoot, Supervisor: Supervisor, log: screen.log});
        if (started === 'setup') { session.detach(mine); listener = null; screen.state = 'setup'; screen.render(); return; }
        bindKeyboard(screen);
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
