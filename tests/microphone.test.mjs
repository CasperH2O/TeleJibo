// Microphone framing, capture controls and subscriber lifecycle; synthetic data only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const M = require('../telejibo/lib/microphone');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(extra = {}) {
    const sockets = [], writes = [], privacy = {enabled:false};
    class Socket {
        constructor(url) { this.url = url; this.readyState = 0; this.closed = 0; sockets.push(this); }
        open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
        message(data) { if(this.onmessage) this.onmessage({data}); }
        close() { this.closed++; this.readyState = 3; if (this.onclose) this.onclose({}); }
    }
    const destination = {writableLength:0, write: bytes => { writes.push(Buffer.from(bytes)); return true; }};
    const m = new M({privacyController:privacy,records:[{name:'audio',port:12345}]},{WebSocket:Socket,timeoutMs:500,readMixer:()=>Promise.resolve({master:{mute:false,recordVolume:1},media:{mute:false,recordVolume:1}}),...extra});
    const failures = []; m.on('failure',error => failures.push(error.message));
    return {m,sockets,writes,privacy,destination,failures};
}
const voice = Buffer.alloc(320,17), reference = Buffer.alloc(320,92), packet = Buffer.concat([voice,reference]);

test('whole binary message gives the speech plane; handshake alone is not PCM readiness', async () => {
    const f = fixture(); let ready = false;
    const started = f.m.start(f.destination).then(() => { ready = true; });
    f.sockets[0].open(); await tick(); assert.equal(ready,false);
    f.sockets[0].message(packet); await started;
    assert.deepEqual(f.writes,[voice]); assert.equal(f.sockets[0].binaryType,'arraybuffer');
    assert.equal(f.sockets[0].url,'ws://127.0.0.1:12345/sout');
    await f.m.stop(); assert.equal(f.sockets[0].closed,1);
});

test('ArrayBuffer retains signed PCM bytes; text and malformed messages fail and close', async () => {
    assert.deepEqual(M.speechPlane(packet.buffer.slice(packet.byteOffset,packet.byteOffset+packet.length)),voice);
    for (const input of ['not audio',Buffer.alloc(0),Buffer.alloc(639),Buffer.alloc(6404)]) {
        const f = fixture(), started = f.m.start(f.destination);
        const rejected = assert.rejects(started,/microphone_message_/);
        f.sockets[0].message(input); await rejected; await f.m.stop();
        assert.equal(f.writes.length,0); assert.equal(f.sockets[0].closed,1);
    }
});

test('congestion drops whole messages while continuing to drain the service', async () => {
    const f = fixture(), started = f.m.start(f.destination);
    await tick(); f.destination.writableLength = 3200;
    for (let i=0;i<10;i++) f.sockets[0].message(packet);
    await started; assert.equal(f.m.received,10); assert.equal(f.m.dropped,10);
    assert.equal(f.writes.length,0); assert.equal(f.sockets[0].closed,0);
    f.destination.writableLength = 0; f.sockets[0].message(packet);
    assert.deepEqual(f.writes,[voice]); await f.m.stop();
});

test('privacy refuses initial capture and drops the first block after privacy activates', async () => {
    const initial = fixture(); initial.privacy.enabled = true;
    await assert.rejects(initial.m.start(initial.destination),/microphone_privacy/);
    assert.equal(initial.sockets.length,0);
    const f = fixture(), started = f.m.start(f.destination);
    await tick(); f.sockets[0].message(packet); await started; f.privacy.enabled = true;
    f.sockets[0].message(packet); await f.m.stop();
    assert.equal(f.writes.length,1); assert.deepEqual(f.failures,['microphone_privacy']);
    assert.equal(f.privacy.enabled,true,'adapter never disables privacy');
});

test('stop cancels readiness immediately and a late old error cannot kill a restarted source', async () => {
    const f = fixture(), pending = f.m.start(f.destination);
    const oldError = f.sockets[0].onerror;
    const rejected = assert.rejects(pending,/microphone_closed/);
    await f.m.stop(); await rejected;
    const next = f.m.start(f.destination); await tick(); f.sockets[1].message(packet); await next;
    oldError({}); assert.equal(f.m.closed,false); assert.equal(f.failures.length,0);
    await f.m.stop();
});

test('missing and stalled audio close the subscription without any service-control API', async () => {
    const f = fixture({timeoutMs:10});
    await assert.rejects(f.m.start(f.destination),/microphone_no_frames/); await f.m.stop();
    assert.equal(f.sockets[0].closed,1);
    const stalled = fixture({stallMs:10}), started = stalled.m.start(stalled.destination);
    await tick(); stalled.sockets[0].message(packet); await started;
    await new Promise(resolve => setTimeout(resolve,30));
    assert.deepEqual(stalled.failures,['microphone_stalled']); await stalled.m.stop();
});

test('late callback from a timed-out stop cannot erase retry cleanup handlers', async () => {
    const f = fixture(), started = f.m.start(f.destination);
    await tick(); f.sockets[0].message(packet); await started;
    f.sockets[0].close = function () { this.readyState = 2; };
    const stopping = f.m.stop(), oldClose = f.sockets[0].onclose;
    await assert.rejects(stopping,/microphone_cleanup_timeout/);
    const retry = f.m.stop(), newClose = f.sockets[0].onclose;
    oldClose({}); assert.equal(f.sockets[0].onclose,newClose);
    f.sockets[0].readyState = 3; newClose({}); await retry;
    assert.equal(f.m.socket,null);
});


test('capture controls honor saved mute and zero capture volume without treating speaker zero as mic mute', () => {
    const mixer = {master:{mute:false,recordVolume:1,playbackVolume:0},media:{mute:false,recordVolume:1}};
    assert.equal(M.captureMuted(mixer),false);
    mixer.master.mute = true; assert.equal(M.captureMuted(mixer),true);
    mixer.master.mute = false; mixer.media.recordVolume = 0; assert.equal(M.captureMuted(mixer),true);
    assert.throws(()=>M.captureMuted({master:mixer.master}),/mixer_state/);
});

test('unknown capture state drains without audio; a confirmed mute supplies silence', async () => {
    let accept;
    const f = fixture({readMixer:()=>new Promise(resolve=>{accept=resolve;})});
    let ready = false;
    const started = f.m.start(f.destination).then(()=>{ready=true;});
    f.sockets[0].message(packet); await tick();
    assert.equal(ready,false); assert.equal(f.writes.length,0);
    accept({master:{mute:true,recordVolume:1},media:{mute:false,recordVolume:1}});
    await tick(); f.sockets[0].message(packet); await started;
    assert.deepEqual(f.writes,[Buffer.alloc(320)]); await f.m.stop();
});


test('browser ArrayBuffers from another context retain their speech plane', () => {
    const vm = require('node:vm');
    const foreign = vm.runInNewContext('new Uint8Array([1,2,3,4,91,92,93,94]).buffer');
    assert.deepEqual(M.speechPlane(foreign),Buffer.from([1,2,3,4]));
});

test('mixer read failure closes the subscription and stale controls yield silence', async () => {
    const broken = fixture({readMixer:()=>Promise.reject(Error('mixer_unavailable'))});
    await assert.rejects(broken.m.start(broken.destination),/mixer_unavailable/);
    await broken.m.stop(); assert.equal(broken.sockets[0].closed,1);
    const f = fixture(), started = f.m.start(f.destination);
    await tick(); f.sockets[0].message(packet); await started;
    f.m.stateAt = Date.now()-751; f.sockets[0].message(packet);
    assert.deepEqual(f.writes,[voice,Buffer.alloc(320)]); await f.m.stop();
});
