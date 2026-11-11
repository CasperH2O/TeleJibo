// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Classic Jibo face (stock 1.9.2 look): tokens, copy and pure geometry for 1280x720.
// Values follow the jibo-ui-classic style guide (black background, Proxima Nova,
// gradient action buttons). No PIXI or DOM here, so the rules are unit tested directly.
// Runs on the robot's Node 6: ES2015 only.

var color = {
    background: '#000000', text: '#FFFFFF', muted: '#BBC6CA', caption: '#828191', accent: '#25F2FB',
    surface: '#282735', track: '#21202B', thumb: '#37364A', danger: '#FD362F', initials: '#FFFFFF',
    video: '#0C0C14', chip: 'rgba(0,0,0,0.62)'
};
// Stock action-button gradients [highlight, shadow] (SDK ActionButton `colors`).
var buttons = {
    neutral: [0x58586D, 0x282735], accent: [0x25F2FB, 0x107799], accept: [0xA3FF4A, 0x2A7922],
    decline: [0xFD362F, 0x990024], engaged: [0xBBC6CA, 0x434D55]
};
// Contact circles use the stock skill-tile gradients, picked by user id.
var tones = [['#25F2FB', '#107799'], ['#FF892F', '#AF4123'], ['#E81853', '#850F40'], ['#3765AB', '#1A2563'],
    ['#FBC230', '#AC661E'], ['#00B078', '#015241'], ['#8EDD40', '#31732A'], ['#2BEFDC', '#086969']];
var font = {title: 'Proxima Nova Soft', body: 'Proxima Nova Light'};
// Controls stay inside the screen minus `margin`, with rounded `corner`s.
var screen = {width: 1280, height: 720, margin: 52, corner: 54, minText: 30};

// UI copy. Telegram terms: the app title must not contain "Telegram"; only the sign-in
// steps name the service, because the person has to find it on their phone.
var text = {
    title: 'TeleJibo', connecting: 'Connecting…', closing: 'Closing…', signedOut: 'Signed out',
    videoCall: 'Video call', noCalls: 'No calls', online: 'Online', missed: 'Missed call',
    incoming: 'Incoming video call', outgoing: 'Calling…', decline: 'Decline', accept: 'Answer', cancel: 'Cancel',
    mute: 'Mute', unmute: 'Unmute', micOff: 'Mic off', camera: 'Camera', tracking: 'Look at me', end: 'End', cameraOff: 'Camera off',
    trackingUnavailable: 'Head tracking is unavailable',
    linkTitle: 'Link Telegram', steps: ['Open Telegram on your phone', 'Settings, Devices, Link Desktop Device', 'Scan the code'],
    waitingScan: 'Waiting for scan…',
    settings: 'Settings', signOut: 'Sign out', back: 'Back',
    backgroundOn: 'Background calls on', backgroundOff: 'Background calls off',
    // The call layout: follow the incoming video, or always one shape.
    orientation: {auto: 'Automatic', landscape: 'Landscape', portrait: 'Portrait'}, video: 'Video: ',
    passwordTitle: 'Two-step password', passwordHint: 'Password', shift: 'Shift', symbols: '#?!', remove: 'Delete', submit: 'Sign in',
    setupMissing: 'TeleJibo is missing its sign-in setup', retry: 'Please try again', mediaStarting: 'Starting camera and microphone…', videoStarting: 'Starting camera…',
    mediaUnavailable: 'Call media unavailable', mediaStopped: 'Call media stopped', stopped: 'Connection stopped'
};

// Title row: name centred like the stock menus, settings in the top right. Pages show
// only on the stock pager bar, as in the stock menus.
var header = {title: {x: 640, y: 68, size: 60}, settings: {x: 1092, y: 56, size: 76}};

// Three columns of two rows (direction A); the grid fills down each column first,
// so the most recent conversations sit at the top left.
var contacts = {
    perPage: 6, columns: 3, rows: 2, x: 112, y: 132, width: 330, height: 243, columnGap: 32.5, rowGap: 24,
    avatar: {size: 136, top: 8, initials: 56}, name: {y: 176, size: 45},
    // A drag past `flip` px turns one page (stock List.PAN_THRESHOLD); `slop` is the tap threshold.
    flip: 150, slop: 30, resistance: 0.3, stretch: 120,
    // Near-critical: a page flip settles in about 25 steps of 1/60 s without overshoot.
    spring: {stiffness: 0.1, damping: 0.6, rest: 0.5, step: 1000 / 60},
    // Stock pager: a 1190x10 track along the bottom with a proportional thumb.
    pager: {x: 45, y: 670, width: 1190, height: 10}
};
contacts.pageWidth = contacts.columns * (contacts.width + contacts.columnGap);

// Status line (centre y per screen).
// On the contacts screen the second card row ends at y 642 and the pager track runs 670-680,
// so the line sits under the pager.
var message = {width: 900, size: 32, y: {landscape: 515, incoming: 395, portrait: 650, contacts: 696, other: 640}};

var incoming = {
    avatar: {x: 640, y: 156, size: 200, initials: 90}, name: {x: 640, y: 311, width: 1000, size: 64},
    sub: {x: 640, y: 374, width: 1000, size: 36},
    button: 150, decline: {x: 405, y: 436}, accept: {x: 725, y: 436}, cancel: {x: 565, y: 436},
    caption: {y: 626, width: 260, size: 40}
};

// Caller video on the left (portrait streams), details and controls on the right.
var portrait = {
    video: {x: 0, y: 0, width: 405, height: 720},
    avatar: {x: 203, y: 360, size: 220, initials: 96},
    name: {x: 480, y: 135, width: 680, size: 64}, kind: {x: 480, y: 198, width: 680, size: 36},
    emojis: {x: 480, y: 560, width: 540, size: 32}, hint: {x: 203, y: 520, width: 340, size: 30},
    row: {x: 480, y: 290, button: 132, gap: 36, caption: 40, captionGap: 22}
};
// Landscape streams fill a 16:9 box above a row of controls.
var landscape = {
    video: {x: 192, y: 0, width: 896, height: 504},
    chip: {x: 216, y: 440, height: 52, padding: 18, size: 36, maxWidth: 560}, emojis: {right: 1064, y: 440},
    row: {y: 540, button: 120, gap: 40}
};
var callButtons = ['mute', 'camera', 'tracking', 'hangup', 'orientation'];
// The orientation control sits apart from the portrait row, with room for its caption.
var orientationButton = {x: 1092, y: 484, size: 96, caption: 176};

var qr = {
    title: {x: 112, y: 104, width: 640, size: 80},
    // Steps stack by their measured line count (up to two lines each), `gap` apart.
    steps: {x: 112, top: 200, gap: 28, badge: 56, badgeSize: 36, textX: 190, width: 562, size: 45, line: 56},
    plate: {x: 808, y: 170, size: 352, radius: 20, padding: 24},
    waiting: {x: 112, y: 612, size: 36}
};
// Two rows of two: the choices above, sign out and back below. Captions sit `gap` under their button.
var settings = {title: {x: 640, y: 68, size: 60}, button: 150,
    background: {x: 405, y: 128}, orientation: {x: 725, y: 128}, signOut: {x: 405, y: 388}, back: {x: 725, y: 388},
    caption: {gap: 40, size: 36, width: 310}};
var password = {
    title: {x: 112, y: 61, size: 54}, field: {x: 112, y: 120, width: 1056, height: 80, size: 36},
    keys: {x: 115, y: 216, width: 96, height: 68, gap: 10, size: 34},
    actions: {y: 528, height: 68, size: 32, items: [['shift', 115, 200], ['symbols', 325, 200], ['delete', 535, 200], ['submit', 745, 420]]}
};
var waiting = {x: 640, y: 360, width: 900, size: 45};

// Stock ActionButtons are drawn 264 px wide and scaled to the wanted size.
var ACTION_BUTTON = 264;
function actionScale(size) { return size / ACTION_BUTTON; }

function slot(index) {
    var column = Math.floor(index / contacts.rows), row = index % contacts.rows;
    return {x: contacts.x + column * (contacts.width + contacts.columnGap), y: contacts.y + row * (contacts.height + contacts.rowGap),
        width: contacts.width, height: contacts.height};
}
function pages(total) { return Math.max(1, Math.ceil(total / contacts.perPage)); }
function pageOf(offset) { return Math.floor(offset / contacts.perPage); }
function counter(offset, total) { return pages(total) > 1 ? (pageOf(offset) + 1) + ' / ' + pages(total) : ''; }
// Neighbouring pages exist only within the list; the last one may be partial.
function neighbours(offset, total) {
    return {previous: offset > 0 ? contacts.perPage : 0, next: Math.max(0, Math.min(contacts.perPage, total - offset - contacts.perPage))};
}
// Stock pager: the thumb is the page's share of the track, at the page's position.
function pager(offset, total) {
    var p = contacts.pager, count = pages(total);
    if (count < 2) return null;
    var thumb = Math.max(p.height * 4, Math.round(p.width / count));
    return {track: {x: p.x, y: p.y, width: p.width, height: p.height},
        thumb: {x: p.x + Math.round((p.width - thumb) * pageOf(offset) / (count - 1)), y: p.y, width: thumb, height: p.height}};
}
// Follow the finger; past the first or last page the strip only stretches.
function drag(delta, around) {
    if (delta > 0 && !around.previous || delta < 0 && !around.next)
        return Math.max(-contacts.stretch, Math.min(contacts.stretch, delta * contacts.resistance));
    return Math.max(-contacts.pageWidth, Math.min(contacts.pageWidth, delta));
}
// -1 back a page, +1 forward, 0 stay.
function release(delta, around) {
    if (delta <= -contacts.flip && around.next) return 1;
    if (delta >= contacts.flip && around.previous) return -1;
    return 0;
}
// One frame of a damped spring towards `target`; settles exactly on it.
function spring(state, target) {
    var s = contacts.spring, velocity = (state.velocity + (target - state.x) * s.stiffness) * s.damping, x = state.x + velocity;
    if (Math.abs(target - x) < s.rest && Math.abs(velocity) < s.rest) return {x: target, velocity: 0, settled: true};
    return {x: x, velocity: velocity, settled: false};
}

// Shorten with an ellipsis until `measure` says the text fits `width`.
function fit(value, width, measure) {
    if (measure(value) <= width) return value;
    var characters = Array.from(value), low = 0, high = characters.length;
    while (low < high) {
        var middle = Math.ceil((low + high) / 2);
        if (measure(characters.slice(0, middle).join('').trim() + '…') <= width) low = middle; else high = middle - 1;
    }
    return low ? characters.slice(0, low).join('').trim() + '…' : '…';
}
function initials(name) {
    var words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 2).map(function (word) { return Array.from(word)[0]; }).join('').toUpperCase() || '?';
}
function tone(id) { return tones[Math.abs(Math.floor(Number(id) || 0)) % tones.length]; }
// The helper sends no presence or call history yet; `online`/`missed` are ready for it.
function status(contact) {
    if (!contact.available) return {text: text.noCalls, color: color.caption, callable: false};
    if (contact.missed) return {text: text.missed, color: color.danger, callable: true};
    if (contact.online) return {text: text.online, color: color.accent, callable: true};
    return {text: text.videoCall, color: color.caption, callable: true};
}
function duration(milliseconds) {
    var seconds = Math.max(0, Math.floor(milliseconds / 1000)), hours = Math.floor(seconds / 3600);
    var two = function (n) { return (n < 10 ? '0' : '') + n; };
    return (hours ? hours + ':' : '') + two(Math.floor(seconds / 60) % 60) + ':' + two(seconds % 60);
}
// The helper supplies upright frames. `orientation` is the person's choice: 'auto' takes the
// layout from the picture's shape and fills its box (centred crop, never stretched); a forced
// layout fills the box the same way when the shapes agree and otherwise shows the whole
// picture inside it, with bars.
function video(width, height, orientation) {
    var shape = height > width ? 'portrait' : 'landscape';
    var mode = orientation === 'landscape' || orientation === 'portrait' ? orientation : shape;
    var box = (mode === 'portrait' ? portrait : landscape).video;
    if (mode === shape) {
        var scale = Math.max(box.width / width, box.height / height);
        var cropWidth = Math.min(width, Math.round(box.width / scale)), cropHeight = Math.min(height, Math.round(box.height / scale));
        return {mode: mode, rect: {x: box.x, y: box.y, width: box.width, height: box.height},
            crop: {x: Math.floor((width - cropWidth) / 2), y: Math.floor((height - cropHeight) / 2), width: cropWidth, height: cropHeight}};
    }
    var fit = Math.min(box.width / width, box.height / height), w = Math.round(width * fit), h = Math.round(height * fit);
    return {mode: mode, rect: {x: box.x + Math.round((box.width - w) / 2), y: box.y + Math.round((box.height - h) / 2), width: w, height: h},
        crop: {x: 0, y: 0, width: width, height: height}};
}
// In-call controls: one row, captions under the portrait row only.
function rowButton(mode, index) {
    if (mode === 'portrait') {
        if (callButtons[index] === 'orientation') return {x: orientationButton.x, y: orientationButton.y, size: orientationButton.size};
        var r = portrait.row;
        return {x: r.x + index * (r.button + r.gap), y: r.y, size: r.button};
    }
    var l = landscape.row, width = callButtons.length * l.button + (callButtons.length - 1) * l.gap;
    return {x: Math.round((screen.width - width) / 2) + index * (l.button + l.gap), y: l.y, size: l.button};
}
function key(index) {
    var k = password.keys;
    return {x: k.x + index % 10 * (k.width + k.gap), y: k.y + Math.floor(index / 10) * (k.height + k.gap), width: k.width, height: k.height};
}
// Inside the margins and clear of the rounded corners of the safe rectangle.
function safe(rect) {
    var m = screen.margin, r = screen.corner, right = screen.width - m, bottom = screen.height - m;
    if (rect.x < m || rect.y < m || rect.x + rect.width > right || rect.y + rect.height > bottom) return false;
    return [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x, rect.y + rect.height], [rect.x + rect.width, rect.y + rect.height]].every(function (p) {
        var cx = Math.min(Math.max(p[0], m + r), right - r), cy = Math.min(Math.max(p[1], m + r), bottom - r);
        return (p[0] - cx) * (p[0] - cx) + (p[1] - cy) * (p[1] - cy) <= r * r;
    });
}

module.exports = {
    color: color, buttons: buttons, tones: tones, font: font, screen: screen, text: text, header: header, contacts: contacts,
    message: message, incoming: incoming, portrait: portrait, landscape: landscape, callButtons: callButtons, orientationButton: orientationButton, qr: qr,
    settings: settings, password: password, waiting: waiting, ACTION_BUTTON: ACTION_BUTTON,
    actionScale: actionScale, slot: slot, pages: pages, pageOf: pageOf, counter: counter, neighbours: neighbours, pager: pager,
    drag: drag, release: release, spring: spring, fit: fit, initials: initials, tone: tone, status: status, duration: duration,
    video: video, rowButton: rowButton, key: key, safe: safe
};
