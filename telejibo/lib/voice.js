// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Voice for TeleJibo: who the person asked to call ("Hey Jibo, video call Anna"), which
// contact that is, and short spoken answers while a question is on screen ("yes", "no",
// "answer", "decline"). Listening uses Jibo's own speech turn (jibo.jetstream), only while
// such a question shows, and never while a call's microphone is open. What is heard is
// used at once and not kept. Runs on the robot's Node 6: ES2015 only.

function words(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9À-￿' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
// The name after "call" in what launched the skill, or ''.
function callee(text) {
    var said = words(text).replace(/^(hey |hello |hi )?jibo /, '');
    var found = /(?:^| )call(?: to| with)? (.+)$/.exec(said);
    if (!found) return '';
    var name = found[1].replace(/ (please|now|for me)$/, '').replace(/ (on|with|using|in|through|via) (telegram|telejibo|tele jibo|telly jibo)$/, '')
        .replace(/^(my |the )/, '').trim();
    if (!name || ['someone', 'somebody', 'a friend', 'me', 'on telegram', 'with telejibo', 'on telejibo', 'telejibo', 'telegram'].indexOf(name) >= 0) return '';
    return name.slice(0, 60);
}
// How well a contact's name fits what was said: 3 the whole name, 2 one of its words
// (a first name), 1 a word that starts with it, 0 no fit.
function fit(said, name) {
    var a = words(said), b = words(name);
    if (!a || !b) return 0;
    if (a === b) return 3;
    var parts = b.split(' ');
    if (parts.indexOf(a) >= 0 || b.indexOf(a + ' ') === 0) return 2;
    return parts.some(function (part) { return part.indexOf(a) === 0 && a.length >= 3; }) ? 1 : 0;
}
// The best callable contact for the spoken name, or null. `certain` is false when another
// contact fits equally well.
function match(said, contacts) {
    var best = null, score = 0, tied = false;
    (contacts || []).forEach(function (contact) {
        if (!contact || !contact.available) return;
        var value = fit(said, contact.name);
        if (value > score) { best = contact; score = value; tied = false; }
        else if (value && value === score && best && best.id !== contact.id) tied = true;
    });
    return best ? {contact: best, score: score, certain: !tied} : null;
}
var YES = ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'call', 'do it', 'go ahead', 'please do', 'answer', 'accept', 'pick up', 'pick it up', 'take it'];
var NO = ['no', 'nope', 'nah', 'cancel', 'stop', 'never mind', 'nevermind', 'decline', 'reject', 'ignore', 'hang up', 'not now', "don't", 'do not'];
// 'yes', 'no' or null for what was said. A refusal wins: "no, don't answer" is a no.
function decision(text) {
    var said = ' ' + words(text) + ' ';
    function has(list) { return list.some(function (phrase) { return said.indexOf(' ' + phrase + ' ') >= 0; }); }
    if (has(NO)) return 'no';
    if (has(YES)) return 'yes';
    return null;
}

// Repeated short listening turns until stop() or `heard(text)` returns true.
class Listener {
    constructor(jibo, log) { this.jibo = jibo; this.log = log; this.token = null; this.turn = null; }
    available() {
        var jetstream = this.jibo && this.jibo.jetstream;
        return !!(jetstream && typeof jetstream.startLocalTurn === 'function') && !(this.jibo.privacyController && this.jibo.privacyController.enabled);
    }
    active() { return !!this.token; }
    // options: {seconds per turn (8), turns (at most; 6)}
    start(heard, options) {
        this.stop();
        if (!this.available()) return false;
        var self = this, jibo = this.jibo, token = this.token = {}, left = options && options.turns || 6, seconds = options && options.seconds || 8;
        function again() {
            if (self.token !== token) return;
            if (left-- <= 0 || !self.available()) { self.token = null; return; }
            // No listening animation over our own screen.
            try { if (jibo.embodied && jibo.embodied.listen && jibo.embodied.listen.disableOnce) jibo.embodied.listen.disableOnce(); } catch (_) {}
            // The cloud returns this rule's transcript as it was heard, with no command matching.
            Promise.resolve().then(function () {
                return jibo.jetstream.startLocalTurn({nluRules: ['agent/conversation'], sosTimeout: seconds, ignoreGlobalRules: true, ignoreHJ: true});
            }).then(function (turn) {
                if (self.token !== token) { try { turn.cancel(); } catch (_) {} return null; }
                self.turn = turn;
                return turn.promise.then(function (result) {
                    if (self.turn === turn) self.turn = null;
                    if (self.token !== token) return;
                    var types = jibo.jetstream.types && jibo.jetstream.types.TurnResultType || {};
                    if (result && (result.status === types.INTERRUPTED || result.status === types.CANCELED) && result.status !== undefined) { self.token = null; return; }
                    var inner = result && result.result, text = inner && (inner.text || inner.asr && inner.asr.text) || '';
                    if (text && heard(String(text)) === true) { self.token = null; return; }
                    again();
                });
            }).catch(function (error) {
                if (self.token !== token) return;
                self.token = null;
                if (self.log) self.log.info('voice: listening is not available (' + (error && (error.message || error)) + ')');
            });
        }
        again();
        return true;
    }
    stop() {
        var turn = this.turn; this.token = null; this.turn = null;
        if (turn) try { turn.cancel(); } catch (_) {}
    }
}

module.exports = {words: words, callee: callee, fit: fit, match: match, decision: decision, Listener: Listener};
