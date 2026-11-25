// Dependency-free Chrome integration/performance checks (Node 22+).
// node scripts/check-hero-scroll.mjs [--baseline] [--screenshots]
// Set CHROME_PATH if Chrome isn't installed in the default Windows location.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const verify = !process.argv.includes('--baseline');

function inspect(file) {
  const b = fs.readFileSync(file), result = {file, bytes:b.length, boxes:[]};
  function walk(start,end) {
    for(let o=start;o+8<=end;) {
      const n=b.readUInt32BE(o),t=b.toString('ascii',o+4,o+8);
      if(n<8) break;
      if(start===0) result.boxes.push(t);
      if(t==='stss') result.keyframes=Array.from({length:b.readUInt32BE(o+12)},(_,i)=>b.readUInt32BE(o+16+i*4));
      if(t==='stsz') result.frames=b.readUInt32BE(o+16);
      if(t==='mdhd'&&b[o+8]===0) { result.timescale=b.readUInt32BE(o+20);result.duration=b.readUInt32BE(o+24)/result.timescale; }
      if(t==='stts') result.frameDuration=b.readUInt32BE(o+20);
      if(t==='ctts') result.reorderedFrames=true;
      if(t==='tkhd') result.size=[b.readUInt32BE(o+n-8)/65536,b.readUInt32BE(o+n-4)/65536];
      if(['moov','trak','mdia','minf','stbl'].includes(t) && (t!=='trak'||b.subarray(o,o+n).includes(Buffer.from('vide')))) walk(o+8,o+n);
      o+=n;
    }
  }
  walk(0,b.length);
  result.keyframeCount=result.keyframes?.length ?? result.frames;
  if(result.keyframes?.length>20) result.keyframes=result.keyframes.slice(0,20);
  return result;
}
if(process.argv[2]==='inspect') {
  for(const f of process.argv.slice(3)) console.log(inspect(f));
} else {
  run().catch(error=>{console.error(error);process.exitCode=1;});
}

async function run() {
  if (verify) for (const name of ['desktop', 'mobile']) {
    const media = inspect(path.join(root, `assets/hero-scroll-${name}.mp4`));
    assert.equal(media.keyframeCount, media.frames, 'Every video frame is independently seekable');
    assert.equal(media.timescale / media.frameDuration, 24, 'Encoding matches CONFIG.videoFPS');
    assert.ok(!media.reorderedFrames, 'No B-frame reordering');
    assert.ok(media.boxes.indexOf('moov') < media.boxes.indexOf('mdat'), 'Metadata loads before video data');
  }
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'vyon-hero-qa-'));
  const server=http.createServer((req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    fs.stat(file,(error,stat)=>{
      if(error||!stat.isFile()){res.writeHead(404).end();return;}
      const mime={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.png':'image/png','.webp':'image/webp','.woff2':'font/woff2','.mp4':'video/mp4'};
      res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
      res.setHeader('Accept-Ranges','bytes');
      res.setHeader('Cache-Control','no-store');
      let start=0,end=stat.size-1;
      const range=req.headers.range?.match(/bytes=(\d+)-(\d*)/);
      if(range){start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);}
      res.setHeader('Content-Length',end-start+1);
      fs.createReadStream(file,{start,end}).pipe(res);
    });
  });
  let chrome,socket;
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    chrome=spawn(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    const endpoint=await new Promise((resolve,reject)=>{
      let output='';const timeout=setTimeout(()=>reject(new Error('Chrome startup timeout')),15000);
      chrome.on('error',reject);chrome.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timeout);resolve(match[1]);}});
    });
    socket=new WebSocket(endpoint);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve);socket.addEventListener('error',reject);});
    let nextId=0;const pending=new Map();const errors=[];
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      const entry=pending.get(message.id);if(!entry)return;
      pending.delete(message.id);clearTimeout(entry.timeout);message.error?entry.reject(message.error):entry.resolve(message.result);
    });
    const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++nextId;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},30000);
      pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params,sessionId}));
    });
    const {targetId}=await send('Target.createTarget',{url:'about:blank'});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    const call=(method,params)=>send(method,params,sessionId);
    const evaluate=async expression=>{
      const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
      if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;
    };
    await call('Page.enable');await call('Runtime.enable');await call('Network.enable');
    await call('Page.addScriptToEvaluateOnNewDocument',{source:`window.__media={frames:[],seeks:[]};document.addEventListener('DOMContentLoaded',()=>{const v=document.querySelector('#product-video');let begin=0;v.addEventListener('seeking',()=>{begin=performance.now()});v.addEventListener('seeked',()=>__media.seeks.push(performance.now()-begin));function frame(now,m){__media.frames.push({now,time:m.mediaTime});v.requestVideoFrameCallback(frame)}if(v.requestVideoFrameCallback)v.requestVideoFrameCallback(frame);},{once:true});`});
    const results=[];
    for(const [width,height,mobile,cpu] of [[1366,768,false,1],[390,844,true,4]].filter(size=>!process.argv.includes('--cold-only')&&(!process.argv.includes('--mobile-only')||size[2]))) {
      await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:mobile?2:1,mobile});
      await call('Emulation.setCPUThrottlingRate',{rate:cpu});
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html?opening=${width}`});
      await evaluate(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else addEventListener('load',resolve,{once:true})})`);
      await delay(1800);
      const ready=await evaluate(`(()=>{const v=document.querySelector('#product-video');return {width:innerWidth,height:innerHeight,src:v.currentSrc,duration:v.duration,ready:v.readyState,gsap:!!window.gsap,lenis:!!window.Lenis,scrollable:document.querySelector('.experience').classList.contains('is-scrollable')}})()`);
      console.log('READY',ready);
      if(verify) assert.ok(ready.src.endsWith(`hero-scroll-${mobile?'mobile':'desktop'}.mp4`),'Only the responsive source is selected');
      if(verify){
        const opening=await evaluate(`(async()=>{
          const v=document.querySelector('#product-video'),cover=new Image();cover.src=v.poster;await cover.decode();
          const canvas=document.createElement('canvas');canvas.width=256;canvas.height=144;const ctx=canvas.getContext('2d',{willReadFrequently:true});
          ctx.drawImage(cover,0,0,256,144);const poster=ctx.getImageData(0,0,256,144).data;
          ctx.drawImage(v,0,0,256,144);const frame=ctx.getImageData(0,0,256,144).data;
          let difference=0;for(let i=0;i<frame.length;i++)if(i%4!==3)difference+=Math.abs(frame[i]-poster[i]);
          return {time:v.currentTime,paused:v.paused,scroll:scrollY,firstFrame:__media.frames[0]?.time,meanPixelDifference:difference/(256*144*3)};
        })()`);
        assert.equal(opening.scroll,0,'Opening is verified before any scroll');
        assert.ok(opening.time>0&&opening.time<1/24,'Actual first sample is primed without scrolling');
        assert.equal(opening.paused,true,'Opening frame does not autoplay');
        assert.equal(opening.firstFrame,0,'First video sample has reached the compositor');
        assert.ok(opening.meanPixelDifference<3,'Loading cover matches the actual opening frame');
        console.log('OPENING PASS',opening);
      }
      const metrics=await evaluate(`(async()=>{
        const v=document.querySelector('#product-video');const section=document.querySelector('.experience');
        const trigger=window.ScrollTrigger?.getAll().find(t=>t.trigger===section);
        window.__media.frames=[];window.__media.seeks=[];
        const started=performance.now();const samples=[];const distance=section.offsetHeight-innerHeight;
        // Native scroll emulates the mobile path; wheel is measured separately.
        for(const [from,to] of [[0,.95],[.95,.08]]) {
          await new Promise(resolve=>{const start=performance.now();function step(now){const p=Math.min(1,(now-start)/3500);scrollTo({top:distance*(from+(to-from)*p),behavior:'instant'});samples.push({now,time:v.currentTime,seeking:v.seeking});if(p<1)requestAnimationFrame(step);else resolve()}requestAnimationFrame(step)});
          await new Promise(r=>setTimeout(r,450));
        }
        await new Promise(r=>setTimeout(r,700));
        const frames=__media.frames;const intervals=frames.slice(1).map((f,i)=>f.now-frames[i].now).sort((a,b)=>a-b);
        const seeks=__media.seeks.slice().sort((a,b)=>a-b);
        const jumps=frames.slice(1).map((f,i)=>Math.abs(f.time-frames[i].time)).sort((a,b)=>a-b);
        const pct=(a,p)=>a[Math.min(a.length-1,Math.floor(a.length*p))]||0;
        return {frames:frames.length,seekCount:seeks.length,seekP50:pct(seeks,.5),seekP95:pct(seeks,.95),frameP50:pct(intervals,.5),frameP95:pct(intervals,.95),jumpP95:pct(jumps,.95),finalTime:v.currentTime,duration:v.duration,elapsed:performance.now()-started,overflow:document.documentElement.scrollWidth>innerWidth,progress:trigger?.progress,videoRect:JSON.stringify(v.getBoundingClientRect())};
      })()`);
      results.push({width,height,cpu,...metrics});console.log('METRICS',JSON.stringify(results.at(-1)));
      if(verify){assert.ok(metrics.frames>250,'Video keeps presenting frames while scrolling');assert.ok(metrics.seekP95<60,'Seek latency stays below one source-frame interval plus scheduling overhead');assert.ok(metrics.jumpP95<.13,'No large footage jumps during continuous scroll');assert.equal(metrics.overflow,false);assert.ok(metrics.finalTime>0&&metrics.finalTime<metrics.duration*.2,'Reverse scroll settles near beginning');}
      await call('Emulation.setCPUThrottlingRate',{rate:1});
      if(verify){
        await evaluate('ScrollTrigger.refresh()');await delay(200);
        const refreshed=await evaluate("document.querySelector('#product-video').currentTime");
        assert.ok(Math.abs(refreshed-metrics.finalTime)<.05,'Layout refresh preserves the video scroll position');
      }
      if(process.argv.includes('--screenshots')){
        const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(root,`.hero-qa-${width}.png`),Buffer.from(data,'base64'));
      }
      if(verify){
        const before=await evaluate('({y:scrollY,frames:__media.frames.length})');
        if(mobile){
          await call('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
          for(let swipe=0;swipe<2;swipe++){
            await call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:700}]});
            for(let y=650;y>=150;y-=50){await call('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:195,y}]});await delay(25);}
            await call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(100);
          }
          await delay(400);
        } else {
          for(let i=0;i<12;i++){await call('Input.dispatchMouseEvent',{type:'mouseWheel',x:1000,y:500,deltaX:0,deltaY:90});await delay(40);}
          await delay(800);
        }
        const after=await evaluate('({y:scrollY,frames:__media.frames.length})');
        console.log(mobile?'TOUCH INPUT':'WHEEL INPUT',{before,after});
        assert.ok(after.y>before.y+400,'Real wheel/touch input moves the page');
        assert.ok(after.frames>before.frames+10,'Real wheel/touch input advances the video');
        console.log(mobile?'TOUCH PASS':'WHEEL PASS',after.frames-before.frames,'presented frames');
        await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await delay(350);
        const reduced=await evaluate(`(()=>{const v=document.querySelector('#product-video');return {static:document.querySelector('.experience').classList.contains('static-mode'),paused:v.paused,time:v.currentTime}})()`);
        assert.equal(reduced.static,true);assert.equal(reduced.paused,true);assert.ok(reduced.time<.05);console.log('REDUCED',reduced);
      }
    }
    if(verify){
      if(!process.argv.includes('--cold-only')){
      // Exercise the native scroll and legacy-video paths together. These must
      // still settle on the latest target when the CDN/API is unavailable.
      await call('Network.setBlockedURLs',{urls:['*gsap*']});
      const legacy=await call('Page.addScriptToEvaluateOnNewDocument',{source:`Object.defineProperty(HTMLVideoElement.prototype,'requestVideoFrameCallback',{value:undefined,configurable:true});`});
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
      await evaluate(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else addEventListener('load',resolve,{once:true})})`);
      const legacyState=await evaluate(`(async()=>{
        const section=document.querySelector('.experience'),v=document.querySelector('#product-video');
        const distance=section.offsetHeight-innerHeight;
        for(const p of [.9,.1,.75,.25]){scrollTo({top:distance*p,behavior:'instant'});await new Promise(r=>setTimeout(r,30));}
        await new Promise(r=>setTimeout(r,600));
        const count=__media.seeks.length;await new Promise(r=>setTimeout(r,400));
        return {time:v.currentTime,ready:v.readyState,native:!window.gsap,legacy:!v.requestVideoFrameCallback,idleSeeks:__media.seeks.length-count};
      })()`);
      assert.equal(legacyState.native,true);assert.equal(legacyState.legacy,true);assert.ok(Math.abs(legacyState.time-2)<.05);assert.equal(legacyState.idleSeeks,0);console.log('NATIVE/LEGACY PASS',legacyState);
      await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:legacy.identifier});
      }

      // A cold 4G load with scroll input before the MP4 has finished loading.
      await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:2,mobile:true});
      await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      await call('Network.setBlockedURLs',{urls:[]});
      await call('Network.clearBrowserCache');
      await call('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:200000,uploadThroughput:75000,connectionType:'cellular4g'});
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
      const cold=await evaluate(`(async()=>{
        if(document.readyState==='loading')await new Promise(r=>document.addEventListener('DOMContentLoaded',r,{once:true}));
        // Let all DOMContentLoaded handlers initialize the sticky scroll range.
        await new Promise(requestAnimationFrame);
        const section=document.querySelector('.experience'),v=document.querySelector('#product-video');
        const distance=section.offsetHeight-innerHeight;const initialReady=v.readyState;
        for(const p of [.85,.12,.25]){scrollTo({top:distance*p,behavior:'instant'});await new Promise(r=>setTimeout(r,40));}
        const started=performance.now();
        while(performance.now()-started<18000 && (v.seeking||Math.abs(v.currentTime-2)>.05))await new Promise(r=>setTimeout(r,100));
        await document.fonts.ready;
        window.ScrollTrigger?.refresh();
        await new Promise(r=>setTimeout(r,500));
        const trigger=window.ScrollTrigger?.getAll().find(t=>t.trigger===section);
        return {initialReady,ready:v.readyState,time:v.currentTime,paused:v.paused,poster:v.getAttribute('poster'),distance,y:scrollY,src:v.currentSrc,status:document.querySelector('.media-status').textContent,gsap:!!window.gsap,triggerProgress:trigger?.progress,animationProgress:trigger?.animation?.progress(),frames:__media.frames.slice(-5),seeks:__media.seeks.length};
      })()`);
      console.log('COLD 4G',cold);
      assert.ok(Math.abs(cold.time-2)<.05,'Cold load catches up to the latest scroll target');assert.equal(cold.paused,true);assert.ok(cold.poster,'Poster remains available during initial loading');console.log('COLD 4G PASS');
      await call('Network.emulateNetworkConditions',{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1});

      await call('Network.setBlockedURLs',{urls:['*hero-scroll-mobile.mp4']});
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
      await evaluate(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else addEventListener('load',resolve,{once:true})})`);
      const backup=await evaluate(`({src:document.querySelector('#product-video').currentSrc,static:document.querySelector('.experience').classList.contains('static-mode')})`);
      assert.ok(backup.src.endsWith('hero-scroll-desktop.mp4'));assert.equal(backup.static,false);console.log('SOURCE BACKUP PASS');

      await call('Network.setBlockedURLs',{urls:['*hero-scroll-*.mp4']});
      await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/index.html`});
      await evaluate(`new Promise(resolve=>{if(document.readyState==='complete')resolve();else addEventListener('load',resolve,{once:true})})`);
      const unavailable=await evaluate(`({static:document.querySelector('.experience').classList.contains('static-mode'),message:document.querySelector('.media-status').textContent})`);
      assert.equal(unavailable.static,true);assert.ok(unavailable.message.length>0);console.log('POSTER FALLBACK PASS');
    }
    fs.writeFileSync(path.join(os.tmpdir(),verify?'vyon-hero-after.json':'vyon-hero-before.json'),JSON.stringify(results,null,2));
    assert.deepEqual(errors,[],'No browser exceptions');
    console.log(verify?'PASS: independent frames, responsive assets, forward/reverse scroll, real inputs, reduced motion, legacy fallback, cold load and source errors.':'Baseline recorded.');
  } finally {
    socket?.close();chrome?.kill();await new Promise(resolve=>server.close(resolve));
    await delay(500);
    if(path.resolve(profile).startsWith(path.join(os.tmpdir(),'vyon-hero-qa-')))try{fs.rmSync(profile,{recursive:true,force:true});}catch{}
  }
}
