// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// The face UI in the classic Jibo style: stock Labels and ActionButtons on black, with
// contact circles, the QR plate and video painted by art.js. Geometry, colours and copy
// live in layout.js. No DOM/chat UI, photo downloads, payload logs or media persistence.
var path = require('path');
var layout = require('./layout'), createArt = require('./art'), createLog = require('./log');
var C = layout.color, T = layout.text, B = layout.buttons;

var STOCK_ICON = function (name) { return 'core://resources/actionIcons/' + name + '.png'; };
var OWN_ICON = function (name) { return path.join(__dirname, '..', 'resources', 'icons', name + '.png'); };
// In-call controls: [id, icon, colours when off, colours when engaged (null: no toggle)].
var CALL = {
    mute: ['mute', STOCK_ICON('mic'), B.neutral, B.engaged],
    camera: ['camera', OWN_ICON('video'), B.neutral, B.accent],
    tracking: ['tracking', STOCK_ICON('face'), B.neutral, B.accent],
    hangup: ['hangup', STOCK_ICON('cancel'), B.decline, null]
};

module.exports = function createScreen(jibo, BeSkill, controller, qrFactory) {
    function frame(fn) { return typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, layout.contacts.spring.step); }
    return class TeleJiboScreen extends BeSkill {
        constructor() {
            super(...arguments);
            this.diagnostics = createLog(this.log);
            this.view = null; this.state = 'starting'; this.page = {offset: 0, total: 0, users: []};
            this.call = null; this.password = ''; this.shift = false; this.symbols = false;
            this.groups = {}; this.labels = {}; this.fills = {}; this.sliding = []; this.cache = new Map();
            this.message = ''; this.muted = false; this.camera = false; this.tracking = false; this.qr = null; this.closing = null;
            this.mediaState = 'connecting'; this.screen = null; this.callStarted = 0; this.clock = null; this.preparing = false;
            this.avatars = new Map(); this.serial = 0; this.art = null; this.decor = null;
            this.videoSprite = null; this.videoTexture = null; this.videoCrop = null; this.videoCanvas = null; this.videoMode = null; this.videoSize = '';
            // Contacts paging: strip offset in px, the finger's drag, the spring and a requested page.
            this.slide = {x: 0, velocity: 0, target: 0}; this.dragging = null; this.animation = null; this.turning = null; this.pan = null;
        }
        // A call holds the robot's microphone; Hey Jibo must not take over mid-call.
        get isInterruptible() { return !this.call; }
        active() {
            var views = jibo.face.views;
            return !!this.view && !this.closing && views.currentView === this.view && this.view.state !== 'destroyed' &&
                !this.view.inputLocked && !(views._viewProcess && views._viewProcess.active);
        }
        // Taps are ignored while the contact pages move.
        moving() { return !!(this.dragging || this.animation || this.turning); }
        open() {
            if (this.view) return;
            this.closing = null; this.state = 'starting'; this.message = '';
            var self = this, views = jibo.face.views;
            if (!views || !views.createView || !views.changeView || !global.PIXI) { this.exit({noElementsOfSurprise: true}); return; }
            this.view = views.createView('View', this.config(views));
            // Ours owns live callbacks and helper state: never rebuild it from a snapshot.
            this.view.viewStateStacked = true;
            this.view.addAction(views.ActionData.CALLBACK, {callback: function () { self.leave(); }}, true, false, views.GESTURE.SWIPE_DOWN);
            views.changeView({addView: this.view, transitionOpen: views.TRANSITION.IN, transitionClose: views.TRANSITION.OUT},
                function () { controller.opened(self); self.render(); },
                function () { self.leave(); }, function () { self.decorate(); self.render(); });
        }
        leave() { if (this.leaving) return; this.leaving = true; this.exit({noElementsOfSurprise: true}); }
        event(value) {
            if (value.event === 'authorization') {
                this.state = value.state; this.qr = value.state === 'qr' ? value.link : null; this.password = '';
                if (value.state === 'ready') controller.send({method: 'contacts', offset: 0});
            } else if (value.event === 'contacts') this.turned(value);
            else if (value.event === 'avatar') { this.avatar(value.user_id, value.jpeg); return; }
            else if (value.event === 'media') this.mediaState = value.state;
            else if (value.event === 'call') {
                // Each call starts with the microphone on and, once the call is up (below), the
                // camera on too; the person can switch it off. A new call never shows the previous
                // call's last video frame.
                if (!this.call || this.call.call_id !== value.call_id) { this.muted = false; this.camera = false; this.mediaState = 'connecting'; this.message = ''; this.callStarted = 0; this.disposeVideo(); }
                // Head tracking, like the camera, is per call.
                this.call = value;
                if (value.state === 'callStateReady' && !this.callStarted) {
                    this.callStarted = Date.now();
                    // The helper keeps its camera off until asked, and the buttons only appear now.
                    this.camera = true; controller.setCamera(true);
                    // Jibo's head follows the person in front of it during the call; the button turns it off.
                    this.look(true, 'default');
                }
                if (['callStateDiscarded', 'callStateError'].indexOf(value.state) >= 0) {
                    this.call = null; this.callStarted = 0; this.disposeVideo();
                    if (this.tracking) { this.tracking = false; controller.setTracking(false); }
                }
            } else if (value.event === 'error') { this.message = T.retry; if (this.turning) this.settle(0); }
            else if (value.event === 'signed_out') { this.state = 'closed'; this.qr = null; }
            this.render();
        }
        // Head tracking on or off for this call; if Jibo cannot start it the button falls back and says so.
        look(wanted, why) {
            var self = this, call = this.call && this.call.call_id;
            this.diagnostics.info('call: tracking', why, '->', wanted ? 'on' : 'off');
            this.tracking = wanted; this.render();
            controller.setTracking(wanted).then(function (on) {
                if (!wanted || on || !self.call || self.call.call_id !== call) return;
                self.tracking = false; self.message = T.trackingUnavailable; self.render();
            });
        }
        config(views) {
            var self = this, components = [], L = layout;
            this.groups = {}; this.labels = {}; this.fills = {}; this.sliding = []; this.cache = new Map();
            function join(group, id) { (self.groups[group] || (self.groups[group] = [])).push(id); }
            function callback(fn) { return {type: views.ActionData.CALLBACK, data: {callback: function () { if (self.active() && !self.moving()) fn(); }}}; }
            function label(group, id, text, x, y, size, width, options) {
                options = options || {};
                var align = options.align || 'center', fill = options.fill || C.text;
                join(group, id); self.labels[id] = text || ' '; self.fills[id] = fill;
                var style = {fontFamily: options.light ? L.font.body : L.font.title, fontSize: size, fill: fill, align: align, fontWeight: options.bold ? 'bold' : 'normal'};
                if (options.lines) { style.wordWrap = true; style.wordWrapWidth = width; style.lineHeight = options.line; }
                // Empty labels otherwise measure as "Sample" in the SDK fitter.
                components.push({type: 'Label', id: id, text: text || ' ', position: {x: x, y: y},
                    targetAnchor: {x: align === 'left' ? 0 : align === 'right' ? 1 : 0.5, y: options.lines ? 0 : 0.5},
                    bounds: {width: width, height: options.lines ? options.lines * options.line + size * 0.6 : size * 1.6}, style: style});
            }
            // Invisible hit area; its look is painted by art.js inside the button's display.
            function area(group, id, x, y, width, height, fn) {
                join(group, id);
                components.push({type: 'Button', id: id, assets: [], position: {x: x, y: y}, hitArea: {x: 0, y: 0, width: width, height: height}, action: callback(fn)});
            }
            // The SDK's own round gradient button, as in the stock skills.
            function action(group, id, icon, colors, x, y, size, fn) {
                join(group, id);
                var scale = L.actionScale(size);
                components.push({type: 'ActionButton', id: id, iconSrc: icon, colors: colors, position: {x: x, y: y},
                    transform: {scaleX: scale, scaleY: scale}, action: callback(fn)});
            }
            function caption(group, id, text, x, y, size, width) { label(group, id, text, x, y, size, width, {light: true}); }
            // Devices open for each call; tell the person while they start.
            function withMedia(go) {
                if (self.preparing) return;
                self.preparing = true; self.message = T.mediaStarting; self.render();
                controller.prepareMedia().then(function () {
                    self.preparing = false; self.message = ''; go(); self.render();
                }, function (error) {
                    self.diagnostics.error('media: showing "' + T.mediaUnavailable + '" because:', error && (error.code || error.message) || error);
                    self.preparing = false; self.message = T.mediaUnavailable; self.render();
                });
            }
            function hangup() { if (self.call) controller.hangup(self.call.call_id); }
            var actions = {
                mute: function () { self.muted = !self.muted; self.diagnostics.info('call: mute button -> microphone', self.muted ? 'muted' : 'on'); controller.send({method: 'call.mute', enabled: self.muted}); self.render(); },
                camera: function () { self.camera = !self.camera; controller.setCamera(self.camera); self.render(); },
                tracking: function () { self.look(!self.tracking, 'button'); },
                hangup: hangup
            };

            var h = L.header, c = L.contacts;
            label('contacts', 'title', T.title, h.title.x, h.title.y, h.title.size, 600);
            action('contacts', 'settings', OWN_ICON('settings'), B.neutral, h.settings.x, h.settings.y, h.settings.size,
                function () { self.state = 'settings'; self.render(); });
            for (let index = 0; index < c.perPage; ++index) {
                var slot = L.slot(index), centre = slot.x + c.width / 2;
                area('contacts', 'contact' + index, slot.x, slot.y, slot.width, slot.height, function () {
                    var contact = self.page.users[index];
                    if (!contact || !contact.available) return;
                    withMedia(function () { controller.send({method: 'call.start', user_id: contact.id}); });
                });
                label('contacts', 'contact' + index + '-text', '', centre, slot.y + c.name.y, c.name.size, c.width - 16);
                label('contacts', 'contact' + index + '-sub', '', centre, slot.y + c.sub.y, c.sub.size, c.width - 16, {fill: C.caption, light: true});
                self.sliding.push({id: 'contact' + index, x: slot.x}, {id: 'contact' + index + '-text', x: centre}, {id: 'contact' + index + '-sub', x: centre});
            }

            var s = L.settings;
            label('settings', 'settingsTitle', T.settings, s.title.x, s.title.y, s.title.size, 600);
            action('settings', 'signOut', STOCK_ICON('shutdown'), B.decline, s.signOut.x, s.signOut.y, s.button,
                function () { controller.send({method: 'logout'}); self.password = ''; self.qr = null; });
            caption('settings', 'signOut-text', T.signOut, s.signOut.x + s.button / 2, s.caption.y, s.caption.size, s.caption.width);
            action('settings', 'back', STOCK_ICON('back'), B.neutral, s.back.x, s.back.y, s.button, function () { self.state = 'ready'; self.render(); });
            caption('settings', 'back-text', T.back, s.back.x + s.button / 2, s.caption.y, s.caption.size, s.caption.width);

            var q = L.qr;
            label('signin', 'qrTitle', T.linkTitle, q.title.x, q.title.y, q.title.size, q.title.width, {align: 'left', bold: true});
            T.steps.forEach(function (step, index) {
                label('signin', 'step' + index, step, q.steps.textX, q.steps.top + index * (q.steps.line + q.steps.gap), q.steps.size, q.steps.width, {align: 'left', lines: 2, line: q.steps.line, light: true});
            });
            label('signin', 'waitingScan', T.waitingScan, q.waiting.x, q.waiting.y, q.waiting.size, 640, {align: 'left', fill: C.caption, light: true});

            var p = L.password;
            label('password', 'passwordTitle', T.passwordTitle, p.title.x, p.title.y, p.title.size, 900, {align: 'left', bold: true});
            label('password', 'password', '', p.field.x + p.field.width / 2, p.field.y + p.field.height / 2, p.field.size, p.field.width - 60);
            for (let i = 0; i < 40; ++i) {
                var key = L.key(i);
                area('password', 'key' + i, key.x, key.y, key.width, key.height, function () {
                    if (Buffer.byteLength(self.password) < 1000) self.password += self.characters()[i];
                    self.render();
                });
                label('password', 'key' + i + '-text', '', key.x + key.width / 2, key.y + key.height / 2, p.keys.size, key.width - 12);
            }
            var keyActions = {
                shift: function () { self.shift = !self.shift; self.render(); },
                symbols: function () { self.symbols = !self.symbols; self.render(); },
                delete: function () { self.password = Array.from(self.password).slice(0, -1).join(''); self.render(); },
                submit: function () { controller.send({method: 'login.password', password: self.password}); self.password = ''; self.render(); }
            };
            p.actions.items.forEach(function (item) {
                var id = item[0], x = item[1], width = item[2], accent = id === 'submit';
                area('password', id, x, p.actions.y, width, p.actions.height, keyActions[id]);
                label('password', id + '-text', T[id === 'delete' ? 'remove' : id], x + width / 2, p.actions.y + p.actions.height / 2, p.actions.size, width - 20,
                    {fill: accent ? '#000000' : C.text, bold: accent});
            });

            label('waiting', 'waiting', T.connecting, L.waiting.x, L.waiting.y, L.waiting.size, L.waiting.width, {fill: C.muted, light: true});

            var n = L.incoming;
            label('incoming', 'callerName', '', n.name.x, n.name.y, n.name.size, n.name.width, {bold: true});
            label('incoming', 'callerSub', '', n.sub.x, n.sub.y, n.sub.size, n.sub.width, {fill: C.muted, light: true});
            [['decline', n.decline, B.decline, 'cancel', T.decline, hangup],
             ['accept', n.accept, B.accept, 'ok', T.accept, function () {
                 var call = self.call;
                 if (call) withMedia(function () {
                     if (self.call && self.call.call_id === call.call_id) controller.send({method: 'call.accept', call_id: call.call_id});
                     else controller.releaseMedia();
                 });
             }],
             ['cancel', n.cancel, B.decline, 'cancel', T.cancel, hangup]].forEach(function (item) {
                var at = item[1];
                action('incoming', item[0], STOCK_ICON(item[3]), item[2], at.x, at.y, n.button, item[5]);
                caption('incoming', item[0] + '-text', item[4], at.x + n.button / 2, n.caption.y, n.caption.size, n.caption.width);
            });

            var o = L.portrait;
            label('portrait', 'pName', '', o.name.x, o.name.y, o.name.size, o.name.width, {align: 'left', bold: true});
            label('portrait', 'pKind', '', o.kind.x, o.kind.y, o.kind.size, o.kind.width, {align: 'left', fill: C.muted, light: true});
            label('portrait', 'pEmojis', '', o.emojis.x, o.emojis.y, o.emojis.size, o.emojis.width, {align: 'left'});
            label('portrait', 'pHint', '', o.hint.x, o.hint.y, o.hint.size, o.hint.width, {fill: C.caption, light: true});
            var a = L.landscape;
            label('landscape', 'lChip', '', a.chip.x + a.chip.padding, a.chip.y + a.chip.height / 2, a.chip.size, a.chip.maxWidth - 2 * a.chip.padding, {align: 'left'});
            label('landscape', 'lEmojis', '', a.emojis.right - a.chip.padding, a.emojis.y + a.chip.height / 2, a.chip.size, 260, {align: 'right'});
            // Toggles are two stock buttons in one place (off and engaged); render shows one.
            L.callButtons.forEach(function (name, index) {
                var spec = CALL[name];
                ['portrait', 'landscape'].forEach(function (mode) {
                    var at = L.rowButton(mode, index), prefix = mode === 'portrait' ? '' : 'l';
                    action(mode, prefix + name, spec[1], spec[2], at.x, at.y, at.size, actions[name]);
                    if (spec[3]) action(mode, prefix + name + 'On', spec[1], spec[3], at.x, at.y, at.size, actions[name]);
                });
                var at = L.rowButton('portrait', index), r = o.row;
                caption('portrait', name + '-text', T[name === 'hangup' ? 'end' : name], at.x + at.size / 2, at.y + at.size + r.captionGap + r.caption / 2,
                    r.caption * 0.8, at.size + r.gap);
            });

            // Last, so the message stays above every screen.
            label('base', 'message', '', layout.screen.width / 2, L.message.y.other, L.message.size, L.message.width, {fill: C.muted, light: true});
            return {viewConfig: {type: 'View', id: 'telejibo', category: 'gui', ignoreSwipeDown: true, transitionStageOnly: true}, componentConfigs: components};
        }
        characters() {
            var text = this.symbols ? "!@#$%^&*()-_=+[]{}\\|;:'\",.<>/?0123456789 " : '1234567890qwertyuiopasdfghjkl zxcvbnm,.?!';
            text = (text + '                                        ').slice(0, 40);
            return this.shift ? text.toUpperCase() : text;
        }
        component(id) {
            if (!this.cache.has(id)) this.cache.set(id, this.view.getComponentById(id));
            return this.cache.get(id);
        }
        show(id, visible) { var component = this.component(id); if (component && component.display) component.display.visible = visible; }
        decorate() { this.ensureDecor(); }
        // Painted layers sit below the SDK components: background, video, then per-screen shapes.
        ensureDecor() {
            var PIXI = global.PIXI, self = this;
            if (this.decor) return true;
            if (!this.view || !this.view.stage || !PIXI || !PIXI.Container || !PIXI.Sprite || typeof document === 'undefined') return false;
            var art = this.art = createArt(PIXI, document), L = layout, c = L.contacts;
            var layer = new PIXI.Container(), d = this.decor = {layer: layer, screens: {}, surfaces: [], slots: [], ghosts: [], keys: []};
            function sprite(parent, texture, x, y, width, height) {
                var item = new PIXI.Sprite(texture); item.position.set(x, y);
                if (width) { item.width = width; item.height = height; }
                parent.addChild(item); return item;
            }
            function group(name) { var item = new PIXI.Container(); layer.addChild(item); d.screens[name] = item; return item; }
            function surface(width, height) { var item = art.owned(width, height); d.surfaces.push(item); return item; }
            var background = new PIXI.Graphics(); background.beginFill(0x000000); background.drawRect(0, 0, L.screen.width, L.screen.height); background.endFill();
            layer.addChild(background);
            d.panel = sprite(layer, art.panel(L.portrait.video.width, L.portrait.video.height), L.portrait.video.x, L.portrait.video.y);
            d.video = new PIXI.Container(); layer.addChild(d.video);

            var contacts = group('contacts');
            [-1, 1].forEach(function (side) {
                for (var i = 0; i < c.perPage; ++i) {
                    var at = L.slot(i);
                    d.ghosts.push({side: side, index: i, x: at.x + side * c.pageWidth, sprite: sprite(contacts, art.ghost(), at.x + side * c.pageWidth, at.y)});
                }
            });
            d.track = sprite(contacts, art.pill(c.pager.width, c.pager.height, C.track), c.pager.x, c.pager.y);
            d.thumb = sprite(contacts, PIXI.Texture.EMPTY, c.pager.x, c.pager.y);
            for (var index = 0; index < c.perPage; ++index) {
                var tile = this.component('contact' + index);
                if (!tile || !tile.display) continue;
                var face = surface(c.avatar.size, c.avatar.size);
                tile.display.addChildAt(sprite(tile.display, face.texture, (c.width - c.avatar.size) / 2, c.avatar.top), 0);
                d.slots[index] = {face: face};
            }

            var signin = group('signin'), q = L.qr;
            d.badges = T.steps.map(function (_step, index) { return sprite(signin, art.badge(index + 1, q.steps.badge, q.steps.badgeSize), q.steps.x, 0); });
            sprite(signin, art.plate(), q.plate.x, q.plate.y);
            var inner = q.plate.size - 2 * q.plate.padding;
            d.qr = surface(inner, inner);
            sprite(signin, d.qr.texture, q.plate.x + q.plate.padding, q.plate.y + q.plate.padding);

            var p = L.password, keys = group('password');
            sprite(keys, art.box(p.field.width, p.field.height, 20, C.surface), p.field.x, p.field.y);
            for (var k = 0; k < 40; ++k) { var at = L.key(k); sprite(keys, art.box(at.width, at.height, 16, C.surface), at.x, at.y); }
            p.actions.items.forEach(function (item) {
                sprite(keys, art.box(item[2], p.actions.height, 16, item[0] === 'submit' ? C.accent : C.surface), item[1], p.actions.y);
            });

            // One caller photo, shared by the incoming and portrait screens.
            d.caller = surface(L.incoming.avatar.size, L.incoming.avatar.size);
            var n = L.incoming, o = L.portrait;
            sprite(group('incoming'), d.caller.texture, n.avatar.x - n.avatar.size / 2, n.avatar.y - n.avatar.size / 2);
            d.callerPortrait = sprite(group('portrait'), d.caller.texture, o.avatar.x - o.avatar.size / 2, o.avatar.y - o.avatar.size / 2, o.avatar.size, o.avatar.size);
            var landscape = group('landscape'), a = L.landscape;
            d.chip = surface(a.chip.maxWidth, a.chip.height); d.chipSprite = sprite(landscape, d.chip.texture, a.chip.x, a.chip.y);
            d.emojiChip = surface(300, a.chip.height); d.emojiSprite = sprite(landscape, d.emojiChip.texture, a.emojis.right - 300, a.emojis.y);
            this.view.stage.addChildAt(layer, 0);
            return true;
        }
        avatar(id, jpeg) {
            if (!global.PIXI || typeof Image === 'undefined' || typeof jpeg !== 'string' || jpeg.length > 100000 || !/^[A-Za-z0-9+/]+=*$/.test(jpeg)) return;
            var self = this, image = new Image();
            image.onload = function () {
                if (self.closing || !self.view) return;
                self.avatars.delete(id);
                // A bounded cache: about ten pages of contacts.
                while (self.avatars.size >= 60) self.avatars.delete(self.avatars.keys().next().value);
                self.avatars.set(id, {image: image, serial: ++self.serial}); self.render();
            };
            image.src = 'data:image/jpeg;base64,' + jpeg;
        }
        paintFace(surface, id, name, initialsSize) {
            var photo = this.avatars.get(id);
            this.art.paintAvatar(surface, id + ':' + (photo ? 'photo' + photo.serial : name), photo && photo.image, layout.tone(id), layout.initials(name), initialsSize);
        }
        videoFrame(canvas) {
            if (!this.view || !global.PIXI || !this.call) return;
            var PIXI = global.PIXI;
            // Each call's media draws to its own canvas; a texture of an earlier one would freeze.
            if (this.videoCanvas !== canvas) this.disposeVideo();
            var created = !this.videoSprite;
            if (created) {
                this.videoCanvas = canvas;
                this.videoTexture = PIXI.Texture.fromCanvas(canvas);
                this.videoSprite = new PIXI.Sprite(PIXI.Texture.EMPTY);
                if (this.decor) this.decor.video.addChild(this.videoSprite); else this.view.stage.addChildAt(this.videoSprite, 0);
            }
            var base = this.videoTexture.baseTexture;
            base.update();
            // Crop (never stretch) to the layout's box. A texture with its own
            // frame keeps it across updates; PIXI 4.6 resets a full one's frame.
            var size = base.width + 'x' + base.height, previous = this.videoMode;
            if (size !== this.videoSize) {
                var fit = layout.video(base.width, base.height), crop = fit.crop, old = this.videoCrop;
                this.videoCrop = new PIXI.Texture(base, new PIXI.Rectangle(crop.x, crop.y, crop.width, crop.height));
                this.videoSprite.texture = this.videoCrop;
                if (old) old.destroy(false);
                this.videoSprite.position.set(fit.rect.x, fit.rect.y);
                this.videoSprite.width = fit.rect.width; this.videoSprite.height = fit.rect.height;
                this.videoSize = size; this.videoMode = fit.mode;
            }
            this.videoSprite.visible = true;
            // Video takes the caller's place, and its shape picks the layout.
            if (created || previous !== this.videoMode) this.render();
        }
        disposeVideo() {
            if (this.videoSprite) { this.videoSprite.destroy(); if (this.videoCrop) this.videoCrop.destroy(false); this.videoTexture.destroy(true); }
            this.videoSprite = null; this.videoTexture = null; this.videoCrop = null; this.videoCanvas = null; this.videoMode = null; this.videoSize = '';
        }
        screenName() {
            if (this.call) return this.call.state === 'callStatePending' ? 'incoming' : this.videoMode === 'landscape' ? 'landscape' : 'portrait';
            return {ready: 'contacts', settings: 'settings', qr: 'signin', password: 'password'}[this.state] || 'waiting';
        }
        // Only changed text: each assignment refits the label's font, which is costly.
        // Never empty: the SDK label drops its texture for '' and the face renderer then fails.
        text(id, value) {
            value = value || ' ';
            if (this.labels[id] === value) return;
            var component = this.component(id);
            if (component) { component.text = this.fit(component, value); this.labels[id] = value; }
        }
        fill(id, value) {
            var component = this.component(id);
            if (!component || this.fills[id] === value) return;
            this.fills[id] = value;
            if (component.style) component.style.fill = value;
            if (component.textDisplay && component.textDisplay.style) component.textDisplay.style.fill = value;
        }
        measure(component, value) {
            var PIXI = global.PIXI;
            if (!PIXI || !PIXI.TextMetrics || !component.style) return null;
            var style = typeof component.style.clone === 'function' ? component.style.clone() : Object.assign({}, component.style);
            if (component._originalFontSize) style.fontSize = component._originalFontSize;
            return PIXI.TextMetrics.measureText(value, style);
        }
        // The SDK shrinks text that overflows its bounds, and diverges (a frozen
        // face) when it cannot fit. Shorten with an ellipsis so it always fits.
        fit(component, value) {
            var bounds = component.bounds, self = this;
            if (!bounds || !bounds.width || !this.measure(component, value)) return value;
            return layout.fit(value, bounds.width, function (candidate) {
                var size = self.measure(component, candidate);
                return !bounds.height || size.height <= bounds.height ? size.width : Infinity;
            });
        }
        render() {
            if (!this.view || typeof this.view.getComponentById !== 'function' || this.view.state === 'destroyed') return;
            var self = this, screen = this.screen = this.screenName(), decorated = this.ensureDecor();
            Object.keys(this.groups).forEach(function (group) {
                self.groups[group].forEach(function (id) { self.show(id, group === 'base' || group === screen); });
            });
            if (screen !== 'contacts' && (this.dragging || this.animation)) { this.dragging = null; this.animation = null; this.slide = {x: 0, velocity: 0, target: 0}; }
            this.panning(screen === 'contacts');
            this.text('message', this.message);
            var message = this.component('message');
            if (message && message.display) message.display.y = layout.message.y[screen] || layout.message.y.other;
            this.text('waiting', this.state === 'closed' ? T.signedOut : this.state === 'stopped' ? T.stopped :
                this.state === 'setup' ? T.setupMissing : T.connecting);
            this.renderContacts(screen);
            this.text('password', this.password ? '•'.repeat(Math.min(Array.from(this.password).length, 24)) : T.passwordHint);
            this.fill('password', this.password ? C.text : C.caption);
            for (var k = 0; k < 40; ++k) this.text('key' + k + '-text', this.characters()[k] === ' ' ? '␣' : this.characters()[k]);
            this.renderCall(screen);
            if (decorated) this.renderDecor(screen);
            this.ticking(!!this.call && !!this.callStarted);
        }
        renderContacts(screen) {
            var page = this.page, c = layout.contacts;
            for (var i = 0; i < c.perPage; ++i) {
                var contact = page.users[i], id = 'contact' + i;
                if (screen === 'contacts' && !contact) [id, id + '-text', id + '-sub'].forEach(function (item) { this.show(item, false); }, this);
                if (!contact) continue;
                var status = layout.status(contact);
                this.text(id + '-text', contact.name.trim());
                this.text(id + '-sub', status.text); this.fill(id + '-sub', status.color);
                var slot = this.decor && this.decor.slots[i];
                if (slot) this.paintFace(slot.face, contact.id, contact.name, c.avatar.initials);
            }
        }
        renderCall(screen) {
            var call = this.call, self = this;
            if (!call) return;
            var name = (call.name || '').trim(), ready = call.state === 'callStateReady', emojis = (call.emojis || []).join(' ');
            this.text('callerName', name);
            this.text('callerSub', call.outgoing ? T.outgoing : T.incoming);
            if (screen === 'incoming') {
                this.show('callerSub', !this.message);
                ['accept', 'decline'].forEach(function (id) { self.show(id, !call.outgoing); self.show(id + '-text', !call.outgoing); });
                this.show('cancel', !!call.outgoing); this.show('cancel-text', !!call.outgoing);
            }
            this.text('pName', name); this.text('pKind', T.videoCall + ' · ' + this.elapsed()); this.text('pEmojis', emojis);
            this.text('pHint', this.mediaState === 'established' ? T.cameraOff : T.connecting);
            if (screen === 'portrait') this.show('pHint', !this.videoSprite);
            this.text('lChip', this.chipText()); this.text('lEmojis', emojis);
            if (screen === 'landscape') this.show('lEmojis', !!emojis);
            this.text('mute-text', this.muted ? T.unmute : T.mute);
            var engaged = {mute: this.muted, camera: this.camera, tracking: this.tracking};
            ['', 'l'].forEach(function (prefix) {
                var mine = (prefix ? 'landscape' : 'portrait') === screen;
                if (!mine) return;
                layout.callButtons.forEach(function (name) {
                    var on = !!engaged[name], usable = ready || name === 'hangup';
                    self.show(prefix + name, usable && !on);
                    if (CALL[name][3]) self.show(prefix + name + 'On', usable && on);
                    if (!prefix) self.show(name + '-text', usable);
                });
            });
        }
        renderDecor(screen) {
            var d = this.decor, page = this.page;
            Object.keys(d.screens).forEach(function (name) { d.screens[name].visible = name === screen; });
            d.panel.visible = screen === 'portrait';
            d.video.visible = screen === 'portrait' || screen === 'landscape';
            if (screen === 'contacts') {
                var around = layout.neighbours(page.offset, page.total), bar = layout.pager(page.offset, page.total);
                d.ghosts.forEach(function (ghost) { ghost.sprite.visible = ghost.index < (ghost.side < 0 ? around.previous : around.next); });
                d.track.visible = d.thumb.visible = !!bar && !this.message;
                if (bar) { d.thumb.texture = this.art.pill(bar.thumb.width, bar.thumb.height, C.thumb); d.thumb.position.set(bar.thumb.x, bar.thumb.y); }
                this.place(this.slide.x);
            }
            if (screen === 'signin') this.stackSteps();
            // The sign-in link is painted only while it is shown, and wiped after.
            if (screen === 'signin' && this.qr) {
                if (d.qr.key !== this.qr) { var code = qrFactory(0, 'M'); code.addData(this.qr); code.make(); this.art.paintQr(d.qr, this.qr, code); }
            } else if (d.qr.key) this.art.wipe(d.qr);
            if (this.call) {
                this.paintFace(d.caller, this.call.user_id, this.call.name || '', layout.incoming.avatar.initials);
                d.callerPortrait.visible = !this.videoSprite;
                this.paintChips();
            }
        }
        // Sign-in steps wrap differently per font, so each starts below the previous one.
        stackSteps() {
            var s = layout.qr.steps, top = s.top, self = this;
            this.decor.badges.forEach(function (badge, index) {
                var step = self.component('step' + index), size = step && self.measure(step, step.text || '');
                if (step && step.display) step.display.y = top;
                badge.y = top;
                top += Math.min(2, Math.max(1, size ? Math.round(size.height / s.line) : 1)) * s.line + s.gap;
            });
        }
        // Landscape chips follow their text width.
        paintChips() {
            var d = this.decor, a = layout.landscape, emojis = (this.call && this.call.emojis || []).join(' ');
            var chip = this.component('lChip'), size = chip && this.measure(chip, chip.text || '');
            if (size) this.art.paintChip(d.chip, size.width + 2 * a.chip.padding, false);
            var emoji = this.component('lEmojis'), width = emojis && emoji && this.measure(emoji, emoji.text || '');
            d.emojiSprite.visible = !!width;
            if (width) this.art.paintChip(d.emojiChip, width.width + 2 * a.chip.padding, true);
        }
        elapsed() { return this.callStarted ? layout.duration(Date.now() - this.callStarted) : T.connecting; }
        chipText() { var name = this.call && (this.call.name || '').trim() || ''; return this.callStarted ? name + ' · ' + this.elapsed() : name; }
        // The call timer: only its two labels and chip change each second.
        ticking(on) {
            var self = this;
            if (on && !this.clock) this.clock = setInterval(function () {
                if (!self.call || !self.view) return;
                self.text('pKind', T.videoCall + ' · ' + self.elapsed()); self.text('lChip', self.chipText());
                if (self.decor) self.paintChips();
            }, 1000);
            if (!on && this.clock) { clearInterval(this.clock); this.clock = null; }
        }
        // Horizontal pan, registered like the SDK List: one stage gesture while contacts show.
        // Re-adding is idempotent and restores it if another List removed the shared recognizer.
        panning(on) {
            var views = jibo.face.views, touch = views._touchManager, gesture = views.GESTURE;
            if (!touch || !gesture || typeof touch.addGesture !== 'function') return;
            if (on) { this.pan = this.pan || this.onPan.bind(this); touch.addGesture(gesture.PAN, this.pan); }
            else if (this.pan) { touch.removeGesture(gesture.PAN); this.pan = null; this.dragging = null; }
        }
        onPan(event) {
            if (this.screen !== 'contacts' || !this.active() || this.turning) { if (this.dragging) { this.dragging = null; this.settle(0); } return; }
            if (!this.dragging) {
                if (event.isFinal) return;
                this.animation = null; this.dragging = {base: this.slide.x, total: 0};
            }
            // Hammer reports the total; the SDK's spoofed pans only per-event movement.
            if (typeof event.deltaX === 'number' && isFinite(event.deltaX)) this.dragging.total = event.deltaX;
            else if (event.srcEvent && isFinite(event.srcEvent.movementX)) this.dragging.total += event.srcEvent.movementX;
            var around = layout.neighbours(this.page.offset, this.page.total);
            if (event.isFinal) {
                var turn = layout.release(this.dragging.total, around);
                this.dragging = null;
                if (turn) this.turn(turn); else this.settle(0);
                return;
            }
            this.place(this.dragging.base + layout.drag(this.dragging.total, around));
        }
        turn(direction) {
            var self = this, offset = this.page.offset + direction * layout.contacts.perPage;
            // The helper serves one page at a time; slide back if it never answers.
            this.turning = {offset: offset, timer: setTimeout(function () { if (self.turning) self.settle(0); }, 8000)};
            controller.send({method: 'contacts', offset: offset});
            this.settle(-direction * layout.contacts.pageWidth);
        }
        // A new page becomes the centre: shift the strip by a page and spring home.
        turned(value) {
            var moved = value.offset - this.page.offset;
            this.page = value;
            if (this.turning) { clearTimeout(this.turning.timer); this.turning = null; }
            if (!moved) return;
            if (this.screen !== 'contacts') { this.slide = {x: 0, velocity: 0, target: 0}; return; }
            var shift = (moved > 0 ? 1 : -1) * layout.contacts.pageWidth;
            this.slide.x += shift;
            if (this.dragging) this.dragging.base += shift; else this.settle(0);
        }
        settle(target) {
            var self = this;
            if (this.turning && target === 0) { clearTimeout(this.turning.timer); this.turning = null; }
            this.slide.target = target;
            if (this.animation) return;
            var token = this.animation = {}, last = Date.now();
            function tick() {
                if (self.animation !== token) return;
                var now = Date.now(), steps = Math.min(4, Math.max(1, Math.round((now - last) / layout.contacts.spring.step))), state = self.slide;
                last = now;
                for (var i = 0; i < steps && !state.settled; ++i) state = layout.spring(state, self.slide.target);
                self.slide = {x: state.x, velocity: state.velocity, target: self.slide.target};
                self.place(state.x);
                if (state.settled) self.animation = null; else frame(tick);
            }
            frame(tick);
        }
        place(x) {
            this.slide.x = x;
            if (!this.view) return;
            var self = this, offset = Math.round(x);
            this.sliding.forEach(function (item) { var component = self.component(item.id); if (component && component.display) component.display.x = item.x + offset; });
            if (this.decor) this.decor.ghosts.forEach(function (ghost) { ghost.sprite.x = ghost.x + offset; });
        }
        halt() {
            this.panning(false); this.animation = null; this.dragging = null;
            if (this.turning) { clearTimeout(this.turning.timer); this.turning = null; }
            this.ticking(false); this.slide = {x: 0, velocity: 0, target: 0};
        }
        disposeDecor() {
            var d = this.decor;
            if (d && !d.layer._destroyed) { if (d.layer.parent) d.layer.parent.removeChild(d.layer); d.layer.destroy({children: true}); }
            if (d) d.surfaces.forEach(function (surface) { surface.texture.destroy(true); });
            if (this.art) this.art.destroy();
            this.decor = null; this.art = null; this.avatars.clear();
        }
        close(done) {
            done = done || function () {};
            if (this.closing) { this.closing.then(function () { done(); }, done); return; }
            var self = this;
            this.password = ''; this.qr = null; this.call = null;
            this.halt();
            this.disposeVideo();
            // Painted textures go once the view (and every sprite using them) is gone.
            this.closing = controller.close().then(function () {
                var views = jibo.face.views, view = self.view;
                if (!view) return;
                if (views.currentView !== view) {
                    if (view.state !== 'destroyed') self.disposeHidden(views, view);
                    self.view = null; return;
                }
                return new Promise(function (resolve, reject) {
                    views.changeView({remove: true, leaveEmpty: views.viewStackLength === 1, transitionClose: views.TRANSITION.OUT},
                        function () { self.view = null; resolve(); }, function () { reject(Error('telejibo_view_close_failed')); });
                });
            }).then(function () { self.disposeDecor(); });
            this.closing.then(function () { self.closing = null; self.leaving = false; done(); }, function (error) { self.closing = null; self.leaving = false; done(error); });
        }
        disposeHidden(views, view) {
            // The archived View.destroy clears manager-wide input queues. Only
            // tear down our own asset-free hidden group/stage after transitions.
            var process = views._viewProcess, tween = jibo.face.tween;
            if (!process || process.active || process.processQueue && process.processQueue.length ||
                !views.ComponentGroup || !views.STATE || !tween || typeof tween.stop !== 'function' || !view.viewStateStacked)
                throw Error('telejibo_hidden_view_cleanup_unavailable');
            var visited = [], parents = [], cursor = views.currentView;
            while (cursor) {
                if (visited.indexOf(cursor) >= 0) throw Error('telejibo_view_parent_cycle');
                visited.push(cursor);
                if (cursor.pausedParent === view) parents.push(cursor);
                cursor = cursor.pausedParent;
            }
            parents.forEach(function (parent) { parent.pausedParent = view.pausedParent; });
            view.pausedParent = null;
            view.status = views.STATE.DESTROYED;
            views.ComponentGroup.prototype.destroy.call(view);
            if (view.stage) {
                tween.stop(view.stage);
                if (view.stage.parent) view.stage.parent.removeChild(view.stage);
                view.stage.destroy({children: true});
            }
            if (view.pauseOverlay) view.pauseOverlay.destroy();
            view.pauseOverlay = null; view._stage = null; view._viewManager = null; view._viewState = null;
        }
        destroy(done) { this.close(error => super.destroy(baseError => done(error || baseError))); }
    };
};
