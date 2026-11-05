// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
// Owner of the Telegram helper (bin/telegram-helper, an ARMv7 TDLib/tgcalls program; see
// docs/HELPER.md). Private stdin/stdout JSON-line pipes, a heartbeat lease and bounded
// output. No listener, raw-update logging or recordings.
var childProcess = require('child_process'), events = require('events'), fs = require('fs'), path = require('path');
var StringDecoder = require('string_decoder').StringDecoder;

var EVENTS = ['helper', 'authorization', 'contacts', 'avatar', 'call', 'media', 'media_stats', 'status', 'error', 'signed_out'];
var LOADER = '/lib/ld-linux-armhf.so.3';

// BEacon writes package files without execute permission. Grant it to our own helper; if
// the file system refuses, start it through the dynamic loader, which only needs to read it.
function launch(appRoot, options) {
    options = options || {};
    var file = options.fs || fs, bin = path.join(appRoot, 'bin'), executable = path.join(bin, 'telegram-helper');
    var mode = file.statSync(executable).mode;
    if (!(mode & 64)) { try { file.chmodSync(executable, 488); mode = file.statSync(executable).mode; } catch (_) { /* refused */ } }
    if (mode & 64) return {command: executable, prefix: []};
    if (file.existsSync(options.loader || LOADER)) return {command: options.loader || LOADER, prefix: ['--library-path', bin, executable]};
    throw Error('helper_not_executable');
}

class Supervisor extends events.EventEmitter {
    constructor(options) {
        super();
        this.options = options;
        this.child = null; this.buffer = ''; this.stopping = null; this.beat = null;
        this.decoder = new StringDecoder('utf8');
        this.timers = options.timers || require('timers');
    }
    start() {
        if (this.child) return true;
        var options = this.options, self = this, spec;
        try { spec = (options.launch || launch)(options.appRoot); }
        catch (_) { this.emit('failure', 'helper_not_executable'); return false; }
        var args = spec.prefix.concat(['--api-file', options.apiFile, '--state-dir', options.stateDir, '--require-heartbeat']);
        if (options.media) args.push('--pipe-media');
        var spawn = options.spawn || childProcess.spawn;
        this.child = spawn(spec.command, args, {cwd: options.dataRoot,
            env: {HOME: options.dataRoot, PATH: '/usr/bin:/bin', LANG: 'C', LD_LIBRARY_PATH: path.join(options.appRoot, 'bin')},
            stdio: options.media ? ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe']});
        var child = this.child;
        child.stdin.on('error', function () { self.fail('helper_input_failed'); });
        // Media pipes outlive each call's RobotMedia: writes still queued when the helper
        // exits fail with EPIPE, which must not become an uncaught error.
        if (options.media) for (var fd = 3; fd <= 6; ++fd) if (child.stdio && child.stdio[fd]) child.stdio[fd].on('error', function () {});
        child.stdout.on('data', function (data) {
            self.buffer += self.decoder.write(data);
            var end;
            while ((end = self.buffer.indexOf('\n')) >= 0) {
                var line = self.buffer.slice(0, end); self.buffer = self.buffer.slice(end + 1);
                if (Buffer.byteLength(line) > 131072) { self.fail('helper_output_limit'); return; }
                try {
                    var value = JSON.parse(line);
                    if (!value || EVENTS.indexOf(value.event) < 0) throw Error('helper_event');
                    self.emit('status', value);
                } catch (_) { self.fail('helper_protocol'); return; }
            }
            if (Buffer.byteLength(self.buffer) > 131072) self.fail('helper_output_limit');
        });
        // Drain diagnostics without retaining text that might contain private data.
        child.stderr.on('data', function () {});
        child.on('error', function () { self.fail('helper_start_failed'); });
        child.on('exit', function () {
            if (self.beat !== null) self.timers.clearInterval(self.beat);
            self.beat = null;
            if (self.child === child) self.child = null;
            self.buffer = '';
            self.decoder = new StringDecoder('utf8');
            self.emit('gone');
        });
        this.beat = this.timers.setInterval(function () { self.send({method: 'ping'}); }, 1000);
        return true;
    }
    send(value) {
        if (!this.child || this.stopping) return false;
        var line = JSON.stringify(value) + '\n';
        if (Buffer.byteLength(line) > 16384) throw Error('helper_input_limit');
        var stream = this.child.stdin;
        if (stream.destroyed || stream.writable === false || stream._writableState && stream._writableState.length > 65536) {
            this.fail('helper_input_blocked'); return false;
        }
        try { stream.write(line); return true; }
        catch (_) { this.fail('helper_input_failed'); return false; }
    }
    fail(reason) {
        this.emit('failure', reason);
        this.stop();
    }
    stop() {
        if (this.stopping) return this.stopping;
        var self = this, child = this.child;
        if (this.beat !== null) this.timers.clearInterval(this.beat);
        this.beat = null;
        if (!child) return Promise.resolve();
        this.stopping = new Promise(function (resolve) {
            var term = null, kill = null, finished = false;
            function done() {
                if (finished) return;
                finished = true;
                if (term !== null) self.timers.clearTimeout(term);
                if (kill !== null) self.timers.clearTimeout(kill);
                self.child = null; self.buffer = ''; self.stopping = null;
                resolve();
            }
            child.once('exit', done);
            term = self.timers.setTimeout(function () { child.kill('SIGTERM'); }, 2000);
            kill = self.timers.setTimeout(function () { child.kill('SIGKILL'); }, 3500);
            try { child.stdin.end('{"method":"close"}\n'); } catch (_) { child.kill('SIGTERM'); }
            if (child.exitCode !== null && child.exitCode !== undefined) done();
        });
        return this.stopping;
    }
}
module.exports = Supervisor;
module.exports.launch = launch;
