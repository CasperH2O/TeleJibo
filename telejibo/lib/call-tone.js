// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Reuse the installed robot sound; no audio is bundled or synthesized here.
// Keep a loading sound alive until its callback: the old SDK's decoder cannot
// be canceled safely by destroying its Sound while a decode is pending.
var serial = 0;
module.exports = class CallTone {
    // options: {src, volume} of another installed robot sound (the incoming ring).
    constructor(jibo, log, options) { this.jibo = jibo; this.log = log; this.current = null; this.options = options || {}; }
    start() {
        if (this.current) return;
        var api = this.jibo.sound, self = this;
        if (!api || !api.add || !api.remove) return;
        var item = {alias: 'telejibo-dial-' + (++serial), loading: true, sound: null};
        this.current = item;
        function remove() { if (item.sound) { item.sound.stop(); api.remove(item.alias); item.sound = null; } }
        item.remove = remove;
        try {
            item.sound = api.add(item.alias, {src: this.options.src || 'jibo-anim-db-animations://audio/device/ds_processing_01.m4a',
                loop: true, volume: this.options.volume || 0.35});
            item.sound.play({loaded: function (error) {
                item.loading = false;
                if (error || self.current !== item) {
                    if (self.current === item) self.current = null;
                    remove();
                    if (error) self.log.warn('calling sound unavailable: ' + (error.message || error));
                }
            }});
        } catch (error) {
            this.current = null; remove();
            this.log.warn('calling sound unavailable: ' + (error.message || error));
        }
    }
    stop() {
        var item = this.current; this.current = null;
        if (!item) return;
        item.sound.stop();
        if (!item.loading) item.remove();
    }
};
