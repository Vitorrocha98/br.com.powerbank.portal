// Dependency-free layout and interaction checks using an isolated headless Chrome.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vyon-viewport-'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer((req, res) => {
  const file = path.resolve(root, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };
  fs.readFile(file, (error, data) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    res.end(data);
  });
});
let chrome, socket;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const executable = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  chrome = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Headless Chrome startup timed out')), 15000);
    chrome.on('error', reject);
    chrome.stderr.on('data', chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timeout);
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
    else entry.resolve(message.result);
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const call = (method, params) => send(method, params, sessionId);
  const evaluate = async expression => {
    const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  await call('Page.enable');
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  await delay(1500);
  await evaluate(`new Promise(resolve => { if (document.readyState === 'complete') resolve(); else window.addEventListener('load', resolve, {once:true}); })`);
  const assert=require('node:assert/strict');
  const baselineFile=path.join(os.tmpdir(),'vyon-mobile-hero-baseline.json');
  const recording=process.argv.includes('--baseline');const baseline=recording?{}:JSON.parse(fs.readFileSync(baselineFile,'utf8'));const results={};let failed=false;
  await delay(1800);
  for(const [width,height]of [[360,640],[390,844],[430,932],[768,1024],[1366,768]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('window.dispatchEvent(new Event("resize"))');await delay(400);
    for(const progress of [0,.52,.96]){
      await evaluate('window.scrollTo({top:(document.querySelector(".experience").offsetHeight-innerHeight)*'+progress+',behavior:"instant"});ScrollTrigger.update()');await delay(550);
      const scene=progress===0?'.copy':progress===.52?'.connection-note':'.end-note';
      const state=await evaluate(`(()=>{const video=document.querySelector('#product-video'),text=document.querySelector('\${scene}'),v=video.getBoundingClientRect(),t=text.getBoundingClientRect();return {gap:Math.round(v.top-t.bottom),video:[Math.round(v.left),Math.round(v.top),Math.round(v.width),Math.round(v.height)],textFont:getComputedStyle(text.querySelector('h1,h2')).fontSize,progress:ScrollTrigger.getAll().find(t=>t.trigger===document.querySelector('.experience')).progress};})()`.replace('\${scene}',scene));
      const key=width+'x'+height+'@'+progress;results[key]=state;
      if(!recording){
        const old=baseline[key];assert.equal(state.video[2],old.video[2]);assert.equal(state.video[3],old.video[3]);
        if(width===1366){assert.deepEqual(state.video,old.video);assert.equal(state.textFont,old.textFont);}
        else {
          assert.equal(state.textFont,results[width+'x'+height+'@0'].textFont,'All mobile titles match');
          
          const layout=await evaluate("(()=>{const v=document.querySelector('#product-video');return {top:v.offsetTop,height:v.parentElement.offsetHeight,overflow:document.documentElement.scrollWidth>innerWidth};})()");
          assert.ok(Math.abs(layout.top-layout.height*.72)<2,'Original lower video anchor');
          assert.equal(layout.overflow,false,'No horizontal overflow');
        }
        console.log('CHECK '+key+': gap '+old.gap+' -> '+state.gap+'px');
        if([390,430].includes(width)){
          const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(os.tmpdir(),'vyon-hero-'+width+'-'+progress+'.png'),Buffer.from(data,'base64'));
        }
      }
    }
  }
  if(recording){fs.writeFileSync(baselineFile,JSON.stringify(results));console.log('Hero baseline saved.');}
  else console.log(failed?'FAIL':'PASS: uniform mobile titles, restored lower video, unchanged video scale and desktop.');
  process.exitCode=failed?1:0;
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await delay(500); }
  server.close();
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'vyon-viewport-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome can briefly retain its temp profile lock. */ }
  }
});
