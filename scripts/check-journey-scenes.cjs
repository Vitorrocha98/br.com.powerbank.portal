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
  const waitForScene=position=>evaluate(`new Promise((resolve,reject)=>{const start=performance.now();function check(){const photos=[...document.querySelectorAll('.journey-image')];if(photos[${position}].classList.contains('is-current')&&photos[${position}].naturalWidth)resolve();else if(performance.now()-start>6000)reject(new Error('Scene timed out'));else setTimeout(check,30);}check();})`);
  const select=position=>evaluate('document.querySelectorAll(".journey-toggle")['+position+'].click()');
  for (const [width,height] of [[360,640],[390,844],[844,390],[1024,768],[1366,768],[1440,900],[1920,1080]]) {
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('window.dispatchEvent(new Event("resize"))');await delay(300);
    for (const position of [0,1,2]) {
      await select(position);await delay(60);
      const issues=await evaluate(`(()=>{const section=document.querySelector('.journey'),r=section.getBoundingClientRect(),issues=[];if(r.height>innerHeight+1&&!section.classList.contains('fold-natural'))issues.push('section height');for(const el of section.querySelectorAll('h2,p,button')){if(!el.offsetWidth||el.closest('[inert]'))continue;const b=el.getBoundingClientRect();if(b.bottom>r.bottom+2||b.right>r.right+2||b.left<r.left-2)issues.push(el.className);}if(section.querySelector('.journey-usecases').getBoundingClientRect().bottom>section.querySelector('.journey-bottom').getBoundingClientRect().top+2)issues.push('accordion overlap');return issues;})()`);
      assert.deepEqual(issues,[],width+'x'+height+' panel '+position);
    }
  }
  console.log('PASS title spacing and section layout in seven viewports.');
  for(const [width,height]of [[1366,768],[390,844]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
    await evaluate('window.dispatchEvent(new Event("resize")); document.querySelector(".journey").scrollIntoView({behavior:"instant"})');await delay(300);
    const before=await evaluate('document.querySelector(".journey-photo").getBoundingClientRect().height');
    for(const position of [1,2,0]){
      await select(position);await waitForScene(position);
      const state=await evaluate(`(()=>{const images=[...document.querySelectorAll('.journey-image')];const active=images.findIndex(image=>image.classList.contains('is-current'));return {active,visible:images.filter(image=>image.getAttribute('aria-hidden')!=='true').length,caption:document.querySelector('[data-journey-caption]').textContent,label:document.querySelectorAll('.journey-item')[active].dataset.journeyLabel,height:document.querySelector('.journey-photo').getBoundingClientRect().height,natural:document.querySelector('.journey').classList.contains('fold-natural'),section:document.querySelector('.journey').getBoundingClientRect().height};})()`);
      assert.equal(state.active,position);assert.equal(state.visible,1);assert.equal(state.caption,state.label);assert.equal(state.height,before);assert(state.section<=height+1||state.natural);
      console.log('PASS scene '+position+' at '+width+'x'+height);
      if(width===1366&&position!==0){
        const {data}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(os.tmpdir(),'vyon-journey-scene-'+position+'.png'),Buffer.from(data,'base64'));
      }
    }
    await evaluate('document.querySelectorAll(".journey-toggle")[0].focus();document.querySelectorAll(".journey-toggle")[0].dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}))');
    assert(await evaluate('document.activeElement===document.querySelectorAll(".journey-toggle")[1]'));
    await evaluate('[1,2,0,2].forEach(i=>document.querySelectorAll(".journey-toggle")[i].click())');await waitForScene(2);
  }
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await delay(200);
  await evaluate('document.querySelector(".journey").scrollIntoView({behavior:"instant"})');await delay(1300);
  await select(0);await delay(100);
  const during=await evaluate('parseFloat(getComputedStyle(document.querySelectorAll(".journey-image")[0]).opacity)');
  assert(during>0&&during<1);await delay(550);
  const middle=await evaluate('parseFloat(getComputedStyle(document.querySelectorAll(".journey-image")[0]).opacity)');
  assert(middle>during&&middle<.99,'The dissolve must still be visible halfway through.');
  assert(await evaluate('getComputedStyle(document.querySelectorAll(".journey-image")[0]).transform!=="none"'));
  await delay(1000);
  assert.equal(await evaluate('parseFloat(getComputedStyle(document.querySelectorAll(".journey-image")[0]).opacity)'),1);
  console.log('PASS crossfade, keyboard and rapid switching.');
  await call('Network.enable');await call('Network.setCacheDisabled',{cacheDisabled:true});
  await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const hook=await call('Page.addScriptToEvaluateOnNewDocument',{source: "const decode=HTMLImageElement.prototype.decode;HTMLImageElement.prototype.decode=function(){const result=decode.call(this);return (this.dataset.src||'').includes('travel')?result.then(()=>new Promise(resolve=>setTimeout(resolve,600))):result;};"});
  await call('Page.reload',{ignoreCache:true});await delay(1400);
  await evaluate('new Promise(resolve=>{if(document.readyState==="complete")resolve();else window.addEventListener("load",resolve,{once:true})})');
  await select(1);await select(2);await waitForScene(2);await delay(800);
  assert(await evaluate('document.querySelectorAll(".journey-image")[2].classList.contains("is-current")'));
  console.log('PASS slower earlier image cannot override the last selection.');
  await call('Page.removeScriptToEvaluateOnNewDocument',{identifier:hook.identifier});
  await call('Network.setBlockedURLs',{urls:['*powerbank-journey-travel.png']});
  await call('Page.reload',{ignoreCache:true});await delay(1400);
  await evaluate('new Promise(resolve=>{if(document.readyState==="complete")resolve();else window.addEventListener("load",resolve,{once:true})})');
  await select(1);await delay(700);
  assert(await evaluate('document.querySelectorAll(".journey-image")[0].classList.contains("is-current")&&document.querySelector("[data-journey-caption]").textContent===document.querySelectorAll(".journey-item")[0].dataset.journeyLabel'));
  console.log('PASS failed image keeps the last complete scene.');
  process.exitCode=0;
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await delay(500); }
  server.close();
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'vyon-viewport-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome can briefly retain its temp profile lock. */ }
  }
});
