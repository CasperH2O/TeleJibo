// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Rounded and anti-aliased shapes are unreliable and costly as PIXI 4 geometry on the
// robot, so each is painted once on a 2D canvas and shared as a texture. Round controls
// are the SDK's own ActionButtons (see screen.js); this paints everything else.
var layout = require('./layout');

function rounded(ctx, x, y, width, height, radius) {
    radius = Math.min(radius, width / 2, height / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius); ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius); ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
}
// Stock tiles shade from the highlight (top left) to the shadow colour.
function gradient(ctx, size, pair) {
    var g = ctx.createLinearGradient(0, 0, size * 0.5, size);
    g.addColorStop(0, pair[0]); g.addColorStop(1, pair[1]);
    return g;
}
function typeface(size) { return 'bold ' + size + 'px "' + layout.font.title + '"'; }

module.exports = function createArt(PIXI, document) {
    var cache = new Map(), c = layout.color;
    function canvas(width, height) { var element = document.createElement('canvas'); element.width = Math.ceil(width); element.height = Math.ceil(height); return element; }
    function shared(key, width, height, draw) {
        if (!cache.has(key)) { var element = canvas(width, height); draw(element.getContext('2d')); cache.set(key, PIXI.Texture.fromCanvas(element)); }
        return cache.get(key);
    }
    // A canvas the caller repaints in place (avatars, chips, QR); it owns the texture.
    function owned(width, height) {
        var element = canvas(width, height);
        return {canvas: element, texture: PIXI.Texture.fromCanvas(element), key: null};
    }
    function refresh(surface) { surface.texture.baseTexture.update(); }
    return {
        box: function (width, height, radius, fill) {
            return shared(['box', width, height, radius, fill].join(':'), width, height, function (ctx) { rounded(ctx, 0, 0, width, height, radius); ctx.fillStyle = fill; ctx.fill(); });
        },
        pill: function (width, height, fill) { return this.box(width, height, height / 2, fill); },
        // Silhouette of a contact whose page is not loaded yet.
        ghost: function () {
            var t = layout.contacts, a = t.avatar;
            return shared('ghost', t.width, t.height, function (ctx) {
                ctx.fillStyle = c.surface;
                ctx.beginPath(); ctx.arc(t.width / 2, a.top + a.size / 2, a.size / 2, 0, Math.PI * 2); ctx.fill();
                rounded(ctx, t.width / 2 - 100, t.name.y - 18, 200, 36, 18); ctx.fill();
                rounded(ctx, t.width / 2 - 65, t.sub.y - 12, 130, 24, 12); ctx.fill();
            });
        },
        // Numbered step, as in the stock setup screens.
        badge: function (number, size, fontSize) {
            return shared('badge:' + number, size, size, function (ctx) {
                ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.fillStyle = c.accent; ctx.fill();
                ctx.fillStyle = '#000000'; ctx.font = typeface(fontSize); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(String(number), size / 2, size / 2 + 1);
            });
        },
        // The caller's panel while no video arrives.
        panel: function (width, height) {
            return shared(['panel', width, height].join(':'), width, height, function (ctx) {
                var g = ctx.createLinearGradient(0, 0, width * 0.4, height); g.addColorStop(0, '#20202E'); g.addColorStop(1, c.video);
                ctx.fillStyle = g; ctx.fillRect(0, 0, width, height);
            });
        },
        plate: function () {
            var p = layout.qr.plate;
            return shared('plate', p.size, p.size, function (ctx) { rounded(ctx, 0, 0, p.size, p.size, p.radius); ctx.fillStyle = '#FFFFFF'; ctx.fill(); });
        },
        owned: owned,
        // Round photo (centre-cropped) or a stock tile gradient with initials.
        paintAvatar: function (surface, key, image, pair, initials, fontSize) {
            if (surface.key === key) return;
            var size = surface.canvas.width, ctx = surface.canvas.getContext('2d');
            ctx.clearRect(0, 0, size, size);
            ctx.save(); ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
            if (image) {
                var side = Math.min(image.width, image.height);
                ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, 0, 0, size, size);
            } else {
                ctx.fillStyle = gradient(ctx, size, pair); ctx.fillRect(0, 0, size, size);
                ctx.fillStyle = c.initials; ctx.font = typeface(fontSize); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                ctx.fillText(initials, size / 2, size / 2 + 2);
            }
            ctx.restore();
            surface.key = key; refresh(surface);
        },
        // Translucent chip sized to its text inside a fixed canvas (a resized
        // canvas would leave PIXI 4.6 with stale texture coordinates).
        paintChip: function (surface, width, right) {
            width = Math.min(Math.ceil(width), surface.canvas.width);
            if (surface.key === width) return;
            var ctx = surface.canvas.getContext('2d'), height = surface.canvas.height;
            ctx.clearRect(0, 0, surface.canvas.width, height);
            rounded(ctx, right ? surface.canvas.width - width : 0, 0, width, height, height / 2); ctx.fillStyle = c.chip; ctx.fill();
            surface.key = width; refresh(surface);
        },
        // Whole modules on white, with a two-module quiet zone inside the plate's padding.
        paintQr: function (surface, key, code) {
            if (surface.key === key) return;
            var size = surface.canvas.width, ctx = surface.canvas.getContext('2d'), count = code.getModuleCount();
            var cell = Math.floor(size / (count + 4)), start = Math.floor((size - cell * count) / 2);
            ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, size, size); ctx.fillStyle = '#000000';
            for (var y = 0; y < count; ++y) for (var x = 0; x < count; ++x) if (code.isDark(y, x)) ctx.fillRect(start + x * cell, start + y * cell, cell, cell);
            surface.key = key; refresh(surface);
        },
        wipe: function (surface) {
            var ctx = surface.canvas.getContext('2d'); ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, surface.canvas.width, surface.canvas.height);
            surface.key = null; refresh(surface);
        },
        destroy: function () { cache.forEach(function (texture) { texture.destroy(true); }); cache.clear(); }
    };
};
