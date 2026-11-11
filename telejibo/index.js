// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// TeleJibo: one-to-one Telegram video calls on Jibo, as a BEam custom skill. This module
// wires the face UI (lib/screen.js) to the Telegram helper (lib/helper.js) and the robot's
// devices (lib/media.js). The helper runs only while the skill is open.
var path = require('path');
var jibo = require('jibo'), BeSkill = require('@be/be-framework').BeSkill;
var Supervisor = require('./lib/helper'), RobotMedia = require('./lib/media'), credentials = require('./lib/credentials');
var paths = require('./lib/paths'), layout = require('./lib/layout'), createScreen = require('./lib/screen');
var createLog = require('./lib/log'), log = createLog(), settings = require('./lib/settings');

var appRoot = __dirname, dataRoot = null;
var supervisor = null, skill = null, media = null, mediaStarting = null, mediaReleasing = null, tracking = null, closePromise = null;
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
    if (controller.mediaReady && supervisor) supervisor.send({method: 'media.ready', enabled: false});
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
    if (!supervisor || !supervisor.child) { log.error('media: no helper is running, so there is nothing to attach the devices to'); return Promise.reject(Error('media_unavailable')); }
    var current = media = new RobotMedia(jibo, {log: skill && skill.log, captureMicrophone: controller.microphoneEnabled});
    current.on('video', function (canvas) { if (skill) skill.videoFrame(canvas); });
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
        return supervisor ? supervisor.stop() : null;
    }).then(function () { supervisor = null; closePromise = null; }, function (error) { closePromise = null; throw error; });
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
    // Temporary video-test build while platform microphone access is investigated.
    microphoneEnabled: false,
    mediaReady: false,
    // The person's choices (lib/settings.js); defaults until the data folder has been read.
    settings: settings.clean(),
    setSetting: function (name, value) {
        var next = Object.assign({}, controller.settings); next[name] = value;
        controller.settings = settings.clean(next);
        try { if (dataRoot) settings.write(dataRoot, controller.settings); }
        catch (error) { log.error('settings: could not be saved:', error && (error.code || error.message)); }
        log.info('settings:', name, '->', controller.settings[name]);
    },
    send: function (value) { return !!supervisor && supervisor.send(value); },
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
        var apiFile;
        try {
            dataRoot = paths.ensureDirectory(paths.dataRoot());
            controller.settings = settings.read(dataRoot);
            apiFile = credentials.apiFile(appRoot, dataRoot);
        } catch (error) { apiFile = null; log.error('sign-in setup unavailable:', error && (error.code || error.message)); }
        if (!apiFile) { screen.state = 'setup'; screen.render(); return; }
        supervisor = new Supervisor({appRoot: appRoot, dataRoot: dataRoot, apiFile: apiFile,
            stateDir: path.join(dataRoot, 'account'), media: true, log: screen.log});
        var statsNoted = 0;
        supervisor.on('status', function (value) {
            // What the helper says about the call: states, errors, and how much video it receives
            // (media_stats counts incoming video only; outgoing is logged by media.js).
            if (value.event === 'call') log.info('helper call', value.state || '');
            if (value.event === 'error') log.error('helper error', value.code || value.message || '');
            if (value.event === 'media_stats' && Date.now() - statsNoted > 5000) {
                statsNoted = Date.now();
                log.debug('helper media_stats: video in', value.decoded_video_frames, 'frames', value.decoded_width + 'x' + value.decoded_height,
                    'audio in', value.nonzero_audio_frames, 'dropped video/speaker', value.dropped_video_frames + '/' + value.dropped_speaker_frames,
                    'pipe failed mic/speaker/video', !!value.microphone_pipe_failed + '/' + !!value.speaker_pipe_failed + '/' + !!value.video_pipe_failed);
            }
            if (media && !media.closed && value.event === 'call') media.setCallActive(value.state === 'callStateReady');
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
            // A close we asked for stops the helper too; its exit is no news then.
            if (closePromise) return;
            // Signed out (the helper said so) or stopped unexpectedly.
            screen.password = ''; screen.qr = null; screen.call = null;
            if (screen.state !== 'closed') screen.state = 'stopped';
            screen.render();
            if (screen.view) screen.leave();
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
