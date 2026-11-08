// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Camera = require('../telejibo/lib/camera');
const tick = () => new Promise(resolve => setImmediate(resolve));
const frame = () => Buffer.alloc(115200, 42);
function fixture(overrides = {}) {
    const posts = [], children = [], sources = [], commands = [];
    const options = {
        log: {info() {}}, timeoutMs: 1000, reserveCheck: () => Promise.resolve(5000),
        post: (route, body) => { posts.push([route, body]); return Promise.resolve(); },
        connect: () => {
            const socket = new PassThrough(); sources.push(socket);
            setImmediate(() => socket.emit('connect')); return socket;
        },
        spawn: (command, args) => {
            commands.push([command, args]);
            const child = Object.assign(new EventEmitter(), {exitCode:null, stdin:new PassThrough(), stdout:new PassThrough(), stderr:new PassThrough()});
            child.kill = signal => { child.exitCode = 0; setImmediate(() => { child.emit('exit',0,signal); child.emit('close',0,signal); }); };
            children.push(child); return child;
        }, ...overrides
    };
    const camera = new Camera({records:[{name:'media',host:'127.0.0.1',port:8486}]}, options);
    return {camera, posts, children, sources, commands};
}

test('native camera waits for a whole frame, preserves split frames, and releases probe/start/stop', async () => {
    const f = fixture(), received = [];
    f.camera.on('frame', bytes => received.push(bytes));
    let ready = false;
    const started = f.camera.start().then(() => { ready = true; });
    await tick();
    assert.equal(ready,false, 'HTTP success is not device readiness');
    f.children[0].stdout.write(frame().subarray(0,123)); await tick();
    assert.equal(ready,false);
    f.children[0].stdout.write(Buffer.concat([frame().subarray(123),frame()]));
    await started;
    assert.equal(received.length,2); assert.deepEqual(received[0],frame());
    assert.deepEqual(f.posts[0],['/media/streaming/start',{enable:true,ip:'127.0.0.1',port:'5000'}]);
    assert.ok(f.commands[0][1].includes('omxvp8dec'));
    assert.ok(f.commands[0][1].includes('video/x-raw,format=I420,width=320,height=240,framerate=10/1,pixel-aspect-ratio=1/1'));
    await f.camera.stop();
    assert.equal(f.sources[0].destroyed,true);
    assert.equal(f.camera.ownsStream,false);
    assert.equal(f.posts[1][0],'/media/streaming/control');
    const restarted = f.camera.start(); await tick(); f.children[1].stdout.write(frame()); await restarted;
    await f.camera.stop();
    assert.equal(f.posts.length,4);
});

test('native camera never stops another stream after conflict, but cleans up an ambiguous start', async () => {
    for (const notStarted of [true,false]) {
        let stops = 0;
        const f = fixture({post: route => {
            if (route.endsWith('/start')) return Promise.reject(Object.assign(Error('start_failed'),{notStarted}));
            stops++; return Promise.resolve();
        }});
        await assert.rejects(f.camera.start(),/start_failed/);
        await f.camera.stop();
        assert.equal(stops,notStarted ? 0 : 1);
        assert.equal(f.children.length,0);
    }
});

test('stop during native POST stops the late producer without spawning a decoder', async () => {
    let finish, stops = 0;
    const f = fixture({post: route => {
        if (route.endsWith('/start')) return new Promise(resolve => { finish = resolve; });
        stops++; return Promise.resolve();
    }});
    const started = f.camera.start(); const rejected = assert.rejects(started,/camera_closed/);
    await tick();
    const stopped = f.camera.stop(); finish();
    await Promise.all([rejected,stopped]);
    assert.equal(stops,1); assert.equal(f.children.length,0);
});

test('stop before the first frame cancels readiness and releases the native service', async () => {
    const f = fixture(), started = f.camera.start();
    const rejected = assert.rejects(started,/camera_closed/); await tick();
    await f.camera.stop(); await rejected;
    assert.equal(f.camera.ownsStream,false);
    assert.equal(f.children[0].exitCode,0);
});

test('decoder loss after readiness is reported; a failed native stop remains retryable', async () => {
    let stops = 0;
    const f = fixture({post: route => {
        if (route.endsWith('/control') && ++stops === 1) return Promise.reject(Error('stop_failed'));
        return Promise.resolve();
    }});
    const failures = []; f.camera.on('failure', error => failures.push(error.message));
    const started = f.camera.start(); await tick(); f.children[0].stdout.write(frame()); await started;
    f.children[0].exitCode = 1; f.children[0].emit('exit',1,null);
    assert.equal(failures.length,1);
    await assert.rejects(f.camera.stop(),/stop_failed/);
    assert.equal(f.camera.ownsStream,true);
    await f.camera.stop(); assert.equal(f.camera.ownsStream,false);
});

test('busy preflight does not start or stop a native producer', async () => {
    const f = fixture({reserveCheck: () => Promise.reject(Error('camera_busy'))});
    await assert.rejects(f.camera.start(),/camera_busy/);
    await f.camera.stop(); assert.equal(f.posts.length,0);
});

test('native camera retries a producer that is not listening yet and cancels a frame timeout', async () => {
    let connects = 0;
    const f = fixture({connect: () => {
        const socket = new PassThrough();
        setImmediate(() => {
            if (++connects === 1) socket.emit('error',Object.assign(Error('not listening'),{code:'ECONNREFUSED'}));
            else socket.emit('connect');
        });
        return socket;
    }});
    const started = f.camera.start();
    await new Promise(resolve => setTimeout(resolve,150));
    assert.equal(connects,2);
    f.children[0].stdout.write(frame()); await started; await f.camera.stop();
    const timed = fixture({timeoutMs:20});
    await assert.rejects(timed.camera.start(),/camera_no_frames/);
    assert.equal(timed.camera.ownsStream,false);
    assert.equal(timed.children[0].exitCode,0);
});

test('a final stop cancels a restart queued behind native cleanup', async () => {
    let release;
    const f = fixture({post: route => route.endsWith('/control') ? new Promise(resolve => { release = resolve; }) : Promise.resolve()});
    const started = f.camera.start(); await tick(); f.children[0].stdout.write(frame()); await started;
    const stopped = f.camera.stop(); await tick();
    const restarting = f.camera.start();
    const rejected = assert.rejects(restarting,/camera_closed/);
    const finalStop = f.camera.stop(); release();
    await Promise.all([stopped,finalStop,rejected]);
    assert.equal(f.children.length,1);
    assert.equal(f.camera.ownsStream,false);
});
