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
  const runtime = await evaluate(`({ gsap: !!window.gsap, ready: document.readyState, tabs: document.querySelectorAll('.model-tab').length })`);
  console.log('Runtime:', JSON.stringify(runtime));
  const sizes = [[360,640],[390,844],[844,390],[1024,768],[1366,768],[1440,900],[1920,1080]];
  let failed = false;
  const screenshotDir = path.join(os.tmpdir(), 'vyon-layout-review');
  if (process.argv.includes('--screenshots')) fs.mkdirSync(screenshotDir, { recursive: true });
  for (const [width, height] of sizes) {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.dispatchEvent(new Event('resize'));`);
    await delay(450);
    const result = await evaluate(`(() => {
      const folds = [...document.querySelectorAll('.benefits,.journey,.models,.energy')].map(fold => {
        const r = fold.getBoundingClientRect();
        const outside = [...fold.querySelectorAll('h2,h3,p,button,.model-caption,.journey-usecases,.energy-footer')].filter(el => {
          if (!el.offsetWidth || !el.offsetHeight || el.closest('[hidden],[inert]')) return false;
          const b = el.getBoundingClientRect();
          return b.bottom > r.bottom + 2 || b.top < r.top - 2 || b.right > r.right + 2 || b.left < r.left - 2;
        }).map(el => el.className || el.tagName);
        return { fold: fold.className, height: Math.round(r.height), outside };
      });
      return { folds, horizontal: document.documentElement.scrollWidth > innerWidth + 1, visibleCards: [...document.querySelectorAll('.model-card')].filter(el=>!el.hidden).length };
    })()`);
    const expectedCards = width >= 1024 && height >= 800 ? 3 : 1;
    const bad = result.horizontal || result.visibleCards !== expectedCards || result.folds.some(fold => (!fold.fold.includes('models') && fold.height > height + 1) || fold.outside.length);
    failed ||= bad;
    console.log(`${bad ? 'FAIL' : 'PASS'} ${width}x${height}: ${JSON.stringify(result)}`);
    // Check every expandable answer and the visible products, including overlap
    // with neighboring content rather than just the section's outer bounds.
    for (let selected = 0; selected < 3; selected++) {
      await evaluate(`document.querySelectorAll('.journey-toggle')[${selected}].click();`);
      await delay(80);
      const state = await evaluate(`(() => {
        const issues = [];
        for (const selector of ['.benefits-content','.journey-usecases','.model-card:not([hidden])','.energy-copy','.energy-card-inner']) {
          document.querySelectorAll(selector).forEach(group => {
            // Tight display lettering intentionally paints beyond its line box;
            // body copy and controls must fit their own boxes completely.
            for (const el of group.querySelectorAll('p:not(.model-price),button')) {
              if (!el.offsetWidth || el.closest('[inert],[hidden]')) continue;
              if (el.scrollHeight > el.clientHeight + 2) issues.push(el.className + ':text overflow');
            }
          });
        }
        const journey = document.querySelector('.journey');
        const bottom = journey.querySelector('.journey-bottom').getBoundingClientRect();
        const usecases = journey.querySelector('.journey-usecases').getBoundingClientRect();
        if (usecases.bottom > bottom.top + 2) issues.push('journey:footer overlap');
        if ([...document.querySelectorAll('.benefits,.journey,.energy')].some(el=>el.offsetHeight>innerHeight+1)) issues.push('section taller than viewport');
        return issues;
      })()`);
      if (state.length) { failed = true; console.log(`FAIL state ${selected} at ${width}x${height}: ${JSON.stringify(state)}`); }
    }
    if (process.argv.includes('--screenshots') && [360,844,1366,1440].includes(width)) {
      for (const selector of ['.benefits','.journey','.models','.energy']) {
        await evaluate(`document.querySelector('${selector}').scrollIntoView({behavior:'instant',block:'start'});`);
        await delay(100);
        const { data } = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const file = path.join(screenshotDir, `${width}-${selector.slice(1)}.png`);
        fs.writeFileSync(file, Buffer.from(data, 'base64'));
      }
    }
  }
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await delay(300);
  const interactions = await evaluate(`(() => {
    const visible = [...document.querySelectorAll('.model-card')].filter(card=>card.offsetWidth && !card.hidden).length === 3;
    const noTabs = !document.querySelector('.model-tabs');
    let details = !!window.MicroModal;
    const modal = document.querySelector('#model-details-modal');
    for (const model of ['Essential','Plus','Pro']) {
      document.querySelector('[data-details="'+model+'"]').click();
      details &&= modal.classList.contains('is-open') && modal.querySelectorAll('li').length === 3 && modal.querySelector('h2').textContent === 'VYON '+model && modal.querySelector('[data-buy]').dataset.model === model;
      if (window.MicroModal) MicroModal.close('model-details-modal');
    }
    document.querySelector('.model-card-pro [data-buy]').click();
    const purchase = document.querySelector('#purchase-dialog').open && document.querySelector('#purchase-title').textContent.includes('VYON Pro');
    document.querySelector('#purchase-dialog').close();
    const brand = !['VYON / 01', 'VYON 01', 'VYON<span>/ 01'].some(text=>document.documentElement.outerHTML.includes(text));
    return {visible, noTabs, details, purchase, brand};
  })()`);
  failed ||= Object.values(interactions).some(value => !value);
  console.log('Interactions:', JSON.stringify(interactions));
  await evaluate(`{ const button = document.querySelector('#model-panel-pro [data-details]'); button.focus(); button.click(); }`);
  await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  const escape = await evaluate(`!document.querySelector('#model-details-modal').classList.contains('is-open') && document.activeElement.matches('#model-panel-pro [data-details]')`);
  console.log('Escape and focus return:', escape);
  failed ||= !escape;
  await evaluate(`document.querySelectorAll('.benefits-description,.model-description,.energy-description').forEach(el=>el.style.fontSize='32px'); window.dispatchEvent(new Event('resize'));`);
  await delay(450);
  const enlargedText = await evaluate(`document.querySelectorAll('.fold-natural').length > 0`);
  console.log('Enlarged text uses natural height:', enlargedText);
  failed ||= !enlargedText;
  await evaluate(`document.querySelectorAll('.benefits-description,.model-description,.energy-description').forEach(el=>el.style.removeProperty('font-size')); window.dispatchEvent(new Event('resize'));`);
  await delay(450);
  await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
  await delay(300);
  const motion = await evaluate(`({ heroScrub: !!ScrollTrigger.getAll().find(trigger=>trigger.trigger===document.querySelector('.experience')), animations: ScrollTrigger.getAll().length, brand: document.querySelector('.identity-word').textContent })`);
  console.log('Motion:', JSON.stringify(motion));
  failed ||= !motion.heroScrub;
  if (process.argv.includes('--screenshots')) console.log('Screenshots:', screenshotDir);
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (socket) socket.close();
  if (chrome) { chrome.kill(); await delay(500); }
  server.close();
  const resolved = path.resolve(profile);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep + 'vyon-viewport-')) {
    try { fs.rmSync(resolved, { recursive: true, force: true }); } catch { /* Chrome can briefly retain its temp profile lock. */ }
  }
});
