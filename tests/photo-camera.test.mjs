// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const Camera = require('../telejibo/lib/photo-camera');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
    const requests = [], images = [], urls = [], revoked = [], frames = [], failures = [], draws = [];
    const rgba = new Uint8ClampedArray(320*240*4);
    for (let i=0; i<rgba.length; i+=4) { rgba[i]=255; rgba[i+3]=255; }
    const canvas = {width:0,height:0,getContext:()=>({fillRect() {},drawImage(...args) { draws.push(args); },getImageData:()=>({data:rgba})})};
    const jibo = {records:[{name:'media',host:'0.0.0.0',port:8486}],privacyController:{enabled:false}};
    const camera = new Camera(jibo,{
        log:{info() {}},requestTimeoutMs:1000,decodeTimeoutMs:1000,
        request:(opts,respond)=>{
            const req = new EventEmitter();
            Object.assign(req,{opts,respond,abort() { this.aborted=true; this.emit('error',Error('aborted')); },end(body) { this.body=body; }});
            requests.push(req); return req;
        },
        browser:{image:()=>{const image={naturalWidth:640,naturalHeight:360}; images.push(image); return image;},
            canvas:()=>canvas,url:jpeg=>{urls.push(jpeg); return 'blob:'+urls.length;},revoke:url=>revoked.push(url)},
        ...options
    });
    camera.on('frame',bytes=>frames.push(bytes)); camera.on('failure',error=>failures.push(error));
    function respond(req,bytes,status=200) {
        const response = new EventEmitter(); response.statusCode=status; response.headers={}; response.resume=()=>{};
        req.respond(response); response.emit('data',Buffer.from(bytes)); response.emit('end'); return response;
    }
    async function jpeg() {
        respond(requests.at(-1),JSON.stringify({id:'a/b?c'})); await tick();
        respond(requests.at(-1),'JPEG fixture; browser decode controlled by test'); await tick();
        return images.at(-1);
    }
    return {camera,jibo,requests,images,urls,revoked,frames,failures,draws,canvas,respond,jpeg};
}

test('preview readiness needs a decoded JPEG, converts real pixels and uses temporary right-camera photos', async () => {
    const f=fixture(); let ready=false;
    const started=f.camera.start().then(()=>{ready=true;});
    assert.equal(f.camera.start(),f.camera.start(),'concurrent starts share preparation');
    try {
        await tick();
        assert.equal(f.requests.length,1);
        assert.equal(f.requests[0].opts.hostname,'127.0.0.1');
        assert.equal(f.requests[0].opts.port,8486);
        assert.equal(f.requests[0].opts.path,'/media/photo');
        assert.deepEqual(JSON.parse(f.requests[0].body),{camera:1,type:1,filters:[]});
        const image=await f.jpeg();
        assert.equal(ready,false,'HTTP/JPEG bytes alone do not establish readiness');
        assert.equal(f.requests[1].opts.path,'/media/photo?id=a%2Fb%3Fc');
        image.onload(); await started;
        assert.equal(f.frames[0].length,115200);
        assert.equal(f.frames[0][0],82); assert.equal(f.frames[0][76800],90); assert.equal(f.frames[0][96000],240);
        assert.deepEqual(f.draws[0].slice(1),[0,30,320,180],'preserves 16:9 aspect inside 4:3');
        assert.deepEqual(f.revoked,['blob:1']);
        assert.equal(f.requests.length,2,'one capture/decode at a time');
        assert.equal(f.camera.timer._idleTimeout,200,'paces the next request after decode');
    } finally { await f.camera.stop(); }
    assert.equal(f.canvas.width,0); assert.equal(f.camera.canvas,null); assert.equal(f.camera.timer,null);
});

test('camera-off cancels POST, GET and JPEG decode; late completions cannot revive capture after restart', async () => {
    for (const stage of ['POST','GET','decode']) {
        const f=fixture(), started=f.camera.start(); const rejected=assert.rejects(started,/camera_closed/);
        await tick();
        if (stage!=='POST') { f.respond(f.requests[0],'{"id":"old"}'); await tick(); }
        if (stage==='decode') { f.respond(f.requests[1],'jpeg'); await tick(); }
        const staleRequest=f.requests.at(-1), staleLoad=f.images[0]?.onload;
        await f.camera.stop(); await rejected;
        const restarted=f.camera.start(); await tick();
        const active=f.camera.cancelRequest;
        if (staleLoad) staleLoad(); else f.respond(staleRequest,'{"id":"late"}');
        await tick(); assert.equal(f.camera.cancelRequest,active); assert.equal(f.frames.length,0);
        const image=await f.jpeg(); image.onload(); await restarted;
        assert.equal(f.frames.length,1);
        assert.equal(f.requests.length,stage==='POST'?3:4);
        await f.camera.stop();
        if (stage==='decode') assert.ok(f.revoked.includes('blob:1')); else assert.ok(staleRequest.aborted);
    }
});

test('privacy prevents initial requests and rejects in-flight photos before decode or forwarding', async () => {
    const blocked=fixture(); blocked.jibo.privacyController.enabled=true;
    await assert.rejects(blocked.camera.start(),/privacy_enabled/); assert.equal(blocked.requests.length,0);
    for (const stage of ['POST','GET','decode']) {
        const f=fixture(), started=f.camera.start(); const rejected=assert.rejects(started,/privacy_enabled/);
        await tick();
        if (stage!=='POST') { f.respond(f.requests[0],'{"id":"new"}'); await tick(); }
        if (stage==='decode') { f.respond(f.requests[1],'jpeg'); await tick(); }
        f.jibo.privacyController.enabled=true;
        if (stage==='decode') f.images[0].onload(); else f.respond(f.requests.at(-1),stage==='POST'?'{"id":"new"}':'jpeg');
        await rejected; assert.equal(f.frames.length,0); assert.equal(f.camera.active,false);
        assert.equal(f.camera.timer,null); assert.equal(f.camera.cancelRequest,null); assert.equal(f.camera.cancelDecode,null);
    }
});

test('invalid responses, truncated responses and oversized JPEGs fail readiness and release requests', async () => {
    for (const kind of ['status','json','id','too-large','truncated']) {
        const f=fixture(), started=f.camera.start(); const rejected=assert.rejects(started,/camera_/);
        await tick();
        if (kind==='status') f.respond(f.requests[0],'',503);
        if (kind==='json') f.respond(f.requests[0],'{');
        if (kind==='id') f.respond(f.requests[0],'{"id":null}');
        if (kind==='too-large') {
            f.respond(f.requests[0],'{"id":"new"}'); await tick();
            f.respond(f.requests[1],Buffer.alloc(4*1024*1024+1));
        }
        if (kind==='truncated') {
            const response=new EventEmitter(); response.statusCode=200; response.headers={};
            f.requests[0].respond(response); response.emit('data',Buffer.from('{')); response.emit('close');
        }
        await rejected; assert.equal(f.camera.active,false); assert.equal(f.camera.cancelRequest,null); assert.equal(f.frames.length,0);
    }
});

test('HTTP and decode deadlines reject without leaking the pending request, image or timer', async () => {
    const http=fixture({requestTimeoutMs:20});
    await assert.rejects(http.camera.start(),/camera_http_timeout/);
    assert.equal(http.requests[0].aborted,true); assert.equal(http.camera.cancelRequest,null);
    const decode=fixture({decodeTimeoutMs:20}), started=decode.camera.start();
    const rejected=assert.rejects(started,/camera_decode_timeout/); await tick(); await decode.jpeg();
    await rejected; assert.deepEqual(decode.revoked,['blob:1']); assert.equal(decode.images[0].src,'');
    assert.equal(decode.camera.cancelDecode,null); assert.equal(decode.camera.timer,null);
});

test('JPEG decode errors and invalid dimensions cannot satisfy readiness', async () => {
    for (const kind of ['corrupt','empty','huge']) {
        const f=fixture(), started=f.camera.start(); const rejected=assert.rejects(started,/camera_decode_failed|camera_invalid_dimensions/);
        await tick(); const image=await f.jpeg();
        if (kind==='corrupt') image.onerror();
        else { image.naturalWidth=kind==='empty'?0:10000; image.naturalHeight=10000; image.onload(); }
        await rejected; assert.equal(f.frames.length,0); assert.equal(f.camera.active,false);
        assert.deepEqual(f.revoked,['blob:1']); assert.equal(f.camera.timer,null);
    }
});

test('a camera failure after readiness cancels capture and emits failure; a new call can recover', async () => {
    const f=fixture(), started=f.camera.start(); await tick(); const image=await f.jpeg(); image.onload(); await started;
    await new Promise(resolve=>setTimeout(resolve,225));
    assert.equal(f.requests.length,3);
    f.respond(f.requests[2],'',503); await tick();
    assert.equal(f.failures.length,1); assert.equal(f.camera.active,false); assert.equal(f.camera.timer,null);
    const next=f.camera.start(); await tick(); const again=await f.jpeg(); again.onload(); await next;
    assert.equal(f.frames.length,2); await f.camera.stop();
});

test('privacy between captures stops before another request, and an active BEam controller is respected', async () => {
    const f=fixture(), started=f.camera.start(); await tick(); const image=await f.jpeg(); image.onload(); await started;
    f.jibo.privacyController.enabled=true;
    await new Promise(resolve=>setTimeout(resolve,225));
    assert.equal(f.requests.length,2); assert.equal(f.failures[0].message,'privacy_enabled');
    assert.equal(f.camera.active,false);
    const busy=fixture(); busy.jibo.cameraStreamController={state:'streaming'};
    await assert.rejects(busy.camera.start(),/camera_busy/); assert.equal(busy.requests.length,0);
});
