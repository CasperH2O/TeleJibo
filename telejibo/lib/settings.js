// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The person's choices, kept in <data root>/settings.json beside the sign-in. That folder
// is TeleJibo's own and outlives skill updates; nothing is written anywhere else.
// Runs on the robot's Node 6: ES2015 only.
var fs = require('fs'), path = require('path');

var ORIENTATIONS = ['auto', 'landscape', 'portrait'];
var DEFAULTS = {
    background: false,      // keep Telegram connected while the skill is closed, to ring for calls
    orientation: 'auto',    // call layout: follow the incoming video, or always one shape
    diagnostics: false      // log load figures during calls (set by hand; there is no button)
};
// The self view is no longer a setting: it shows in every call and a tap hides it for that
// call. A `selfView` key in an older settings.json is ignored and dropped on the next save.

// Known keys with valid values only; everything else falls back to its default.
function clean(values) {
    var out = {}, given = values && typeof values === 'object' ? values : {};
    Object.keys(DEFAULTS).forEach(function (key) {
        var value = given[key], fallback = DEFAULTS[key];
        if (key === 'orientation') out[key] = ORIENTATIONS.indexOf(value) >= 0 ? value : fallback;
        else out[key] = typeof value === 'boolean' ? value : fallback;
    });
    return out;
}
function file(dataRoot) { return path.join(dataRoot, 'settings.json'); }
function read(dataRoot) {
    try {
        var target = file(dataRoot), st = fs.statSync(target);
        if (!st.isFile() || st.size > 4096) return clean();
        return clean(JSON.parse(fs.readFileSync(target, 'utf8')));
    } catch (_) { return clean(); }
}
// Atomic, like the sign-in key: a half-written file can never be read back.
function write(dataRoot, values) {
    var target = file(dataRoot), temporary = target + '.tmp', value = clean(values);
    fs.writeFileSync(temporary, JSON.stringify(value) + '\n', {mode: 384});
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 384); } catch (_) { /* the simulator's file system keeps host modes */ }
    return value;
}
function nextOrientation(value) { return ORIENTATIONS[(ORIENTATIONS.indexOf(value) + 1) % ORIENTATIONS.length]; }

module.exports = {DEFAULTS: DEFAULTS, ORIENTATIONS: ORIENTATIONS, clean: clean, file: file, read: read, write: write,
    nextOrientation: nextOrientation};
