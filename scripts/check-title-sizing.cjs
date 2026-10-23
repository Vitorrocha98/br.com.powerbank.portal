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
  const file=path.join(os.tmpdir(),'vyon-title-baseline.json');
  const recording=process.argv.includes('--baseline');
  const baseline=recording?{}:JSON.parse(fs.readFileSync(file,'utf8'));
  const results={};let failed=false;
  for(const [width,height]of [[360,640],[390,844],[844,390],[1024,768],[1366,768],[1440,900],[1920,1080]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('window.dispatchEvent(new Event("resize"))');await delay(450);
    const data=await evaluate(`[...document.querySelectorAll('#hero-title,.benefits-title,.journey-title,.models-title,.energy-title')].map(el=>{const s=getComputedStyle(el);return {title:el.id,font:parseFloat(s.fontSize),leading:parseFloat(s.lineHeight)/parseFloat(s.fontSize),height:Math.round(el.getBoundingClientRect().height)}})`);
    const key=width+'x'+height;results[key]=data;
    if(recording)continue;
    for(let i=0;i<data.length;i++){
      const old=baseline[key][i],now=data[i];
      if(Math.abs(now.font/old.font-.92)>.003||now.leading<=old.leading||Math.abs(now.height/old.height-1)>.12){failed=true;console.log('FAIL type '+key+' '+JSON.stringify({before:old,after:now}));}
    }
    for(let panel=0;panel<3;panel++){
      await evaluate('document.querySelectorAll(".journey-toggle")['+panel+'].click()');await delay(70);
      const issues=await evaluate(`(()=>{const issues=[];for(const fold of document.querySelectorAll('.benefits,.journey,.energy')){const r=fold.getBoundingClientRect();if(r.height>innerHeight+1)issues.push(fold.className+':tall');for(const el of fold.querySelectorAll('h2,p,button')){if(!el.offsetWidth||el.closest('[inert]'))continue;const b=el.getBoundingClientRect();if(b.bottom>r.bottom+2||b.left<r.left-2||b.right>r.right+2)issues.push(el.className+':outside');}}if(document.querySelector('.journey-usecases').getBoundingClientRect().bottom>document.querySelector('.journey-bottom').getBoundingClientRect().top+2)issues.push('accordion overlap');return issues;})()`);
      if(issues.length){failed=true;console.log('FAIL layout '+key+' '+JSON.stringify(issues));}
    }
    console.log('CHECK '+key+': '+data.map((now,i)=>now.title+' '+baseline[key][i].font+' -> '+now.font+'px').join('; '));
    if(process.argv.includes('--screenshots')&&[360,1366].includes(width))for(const selector of ['.benefits','.journey','.energy']){
      await evaluate('document.querySelector("'+selector+'").scrollIntoView({behavior:"instant",block:"start"})');await delay(80);
      const {data:image}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(os.tmpdir(),'vyon-titles-'+width+'-'+selector.slice(1)+'.png'),Buffer.from(image,'base64'));
    }
  }
  if(recording){fs.writeFileSync(file,JSON.stringify(results));console.log('Title baseline saved.');}
  else console.log(failed?'FAIL':'PASS: 8% smaller titles, more line spacing, seven viewports and all accordion panels.');
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
