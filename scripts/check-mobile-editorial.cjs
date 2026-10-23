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
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/index.html` });
  await delay(1500);
  await evaluate(`new Promise(resolve => { if (document.readyState === 'complete') resolve(); else window.addEventListener('load', resolve, {once:true}); })`);
  const assert=require('node:assert/strict');
  for(const [width,height]of [[360,640],[390,844],[430,932],[844,390],[1366,768]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('window.dispatchEvent(new Event("resize"))');await delay(350);
    for(const panel of [0,1,2]){
      await evaluate('document.querySelectorAll(".journey-toggle")['+panel+'].click()');await delay(120);
      const state=await evaluate(`(()=>{
        const rect=s=>document.querySelector(s).getBoundingClientRect(),b=rect('.benefits-photo'),c=rect('.benefits-content'),p=rect('.journey-photo'),u=rect('.journey-usecases');
        const issues=[];for(const sel of ['.benefits','.journey']){const fold=document.querySelector(sel),r=fold.getBoundingClientRect();for(const el of fold.querySelectorAll('h2,p,button,.benefits-photo,.journey-photo')){if(!el.offsetWidth||el.closest('[inert]'))continue;const q=el.getBoundingClientRect();if(q.bottom>r.bottom+2||q.left<r.left-2||q.right>r.right+2)issues.push(el.className);}}
        return {ratio2:b.width/b.height,ratio3:p.width/p.height,gap2:c.top-b.bottom,gap3:u.top-p.bottom,issues,overflow:document.documentElement.scrollWidth>innerWidth,labels:[...document.querySelectorAll('.benefits-rail>span:first-child,.journey-rail>span:first-child,.models-rail>span:first-child,.energy-rail>span:first-child')].map(el=>el.textContent),heights:[rect('.benefits').height,rect('.journey').height]};
      })()`);
      assert.deepEqual(state.issues,[]);assert.equal(state.overflow,false);assert(state.labels.every(label=>!/^\d/.test(label)));
      if(width<768&&height>560){assert(Math.abs(state.ratio2-1)<.01);assert(Math.abs(state.ratio3-1.5)<.01);assert(state.gap2>=15&&state.gap2<=17);assert(state.gap3>=15&&state.gap3<=17);}
      console.log('PASS '+width+'x'+height+' panel '+panel);
    }
    if(width===390){for(const selector of ['.benefits','.journey']){await evaluate('document.querySelector("'+selector+'").scrollIntoView({behavior:"instant"})');const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(os.tmpdir(),'vyon-mobile-'+selector.slice(1)+'.png'),Buffer.from(data,'base64'));}}
  }
  console.log('PASS: photo proportions, 16px gaps, accordion content and section labels.');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await delay(500); }
  server.close();
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'vyon-viewport-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome can briefly retain its temp profile lock. */ }
  }
});
