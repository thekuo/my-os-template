// Browser test of the injected shell script against a mock app page and a mock native bridge.
// Run: PW=$(npm root -g)/playwright node android/test/shell.test.mjs android/overlay/app/src/main/assets/myos-shell.js
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW);
const shim = readFileSync(process.argv[2], 'utf8').replace('__MYOS_SHELL_VERSION__', 'test');
const future = new Date(Date.now() + 3600e3).toISOString();
const state = { timer: { task_id: 't1', title: 'Write report', started_at: new Date(Date.now() - 60000).toISOString() },
  tasks: [{ id: 't1', title: 'Write report', reminder_at: future }, { id: 't2', title: 'Done one', reminder_at: future, completed_at: '2026-10-01' }] };
const page_html = `<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="background:#F7F7F5;margin:0">
<div id=app><div class=scroller id=scroller style="height:100vh;overflow:auto"><div style="height:900px"></div><div class="row open" id=card style="height:300px;background:#eee">card<input id=inp></div><div style="height:900px"></div></div></div>
<button id=plus>+</button><div id=scrim class=scrim hidden></div>
<script>
window.calls = [];
window.Capacitor = { nativePromise: (p, m, o) => { calls.push([p, m, o]);
  if (m === 'checkPermissions') return Promise.resolve({ display: 'granted' });
  if (m === 'deviceStatus') return Promise.resolve({ paired: true });
  if (m === 'screenshot') { window.scrimVisDuringShot = getComputedStyle(document.getElementById('scrim')).visibility; return Promise.resolve({ dataUrl: 'data:image/jpeg;base64,AAAA' }); }
  return Promise.resolve({}); } };
window.webShake = 0;
addEventListener('devicemotion', e => { const a = e.accelerationIncludingGravity; const sc = document.getElementById('scrim'); if (a && Math.hypot(a.x,a.y,a.z) > 30 && sc.hidden) { webShake++; sc.innerHTML = '<div class=pop><textarea id=fb-note></textarea></div>'; sc.hidden = false; } });
</script></body></html>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const posted = [];
await page.route('https://v1.my-os.example.com/**', async route => {
  const u = new URL(route.request().url()), m = route.request().method();
  if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: page_html });
  if (u.pathname === '/api/v1/state') return route.fulfill({ json: state });
  if (u.pathname === '/api/v1/timer') return route.fulfill({ json: { stopped: {}, running: null } });
  if (u.pathname === '/api/v1/tasks/t1' && m === 'PATCH') return route.fulfill({ json: { id: 't1', title: 'Write report', reminder_at: null } });
  if (u.pathname === '/api/v1/feedback') { posted.push(JSON.parse(route.request().postData())); return route.fulfill({ json: { ok: true } }); }
  if (u.pathname === '/api/v1/devices') return route.fulfill({ status: 404, json: {} });
  return route.fulfill({ status: 404, body: '' });
});
await page.goto('https://v1.my-os.example.com/');
await page.evaluate(shim);
await page.waitForTimeout(1500);
const c1 = await page.evaluate(() => calls.map(c => c[0] + '.' + c[1]));
const ok = (name, cond) => { console.log((cond ? 'PASS ' : 'FAIL ') + name); if (!cond) process.exitCode = 1; };
ok('timer notification from initial state', c1.includes('MyOSShell.setTimer'));
const sched = await page.evaluate(() => calls.find(c => c[1] === 'schedule'));
ok('one reminder scheduled (completed one skipped)', sched && sched[2].notifications.length === 1 && sched[2].notifications[0].title === 'Write report');
ok('schedule.at is JS ISO format', sched && /\.\d{3}Z$/.test(sched[2].notifications[0].schedule.at));
// stop timer via app fetch
await page.evaluate(() => fetch('/api/v1/timer', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ action: 'stop' }) }));
await page.waitForTimeout(300);
ok('timer cleared after stop', (await page.evaluate(() => calls.map(c => c[1]))).includes('clearTimer'));
// clear reminder via PATCH
await page.evaluate(() => { calls.length = 0; return fetch('/api/v1/tasks/t1', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ reminder_at: null }) }); });
await page.waitForTimeout(1200);
const c2 = await page.evaluate(() => calls.map(c => c[1]));
ok('reminder cancelled, none rescheduled, widget refreshed', c2.includes('cancel') && !c2.includes('schedule') && c2.includes('refreshWidget'));
// shake: screenshot first, then app handler sees it
await page.evaluate(() => window.dispatchEvent(new DeviceMotionEvent('devicemotion', { accelerationIncludingGravity: { x: 40, y: 0, z: 0 } })));
await page.waitForTimeout(300);
const sh = await page.evaluate(() => ({ web: webShake, shot: calls.some(c => c[1] === 'screenshot'), vis: window.scrimVisDuringShot, after: getComputedStyle(document.getElementById('scrim')).visibility }));
ok('shake: screenshot taken with the sheet hidden, sheet visible after', sh.shot && sh.web === 1 && sh.vis === 'hidden' && sh.after === 'visible');
await page.evaluate(() => { const sc = document.getElementById('scrim'); sc.hidden = true; sc.innerHTML = ''; });
await page.evaluate(() => fetch('/api/v1/feedback', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ note: 'hi' }) }));
ok('feedback POST carries the screenshot', posted.length === 1 && posted[0].screenshot === 'data:image/jpeg;base64,AAAA' && posted[0].note === 'hi');
ok('feedback app_version carries the Android build', /android test$/.test(posted[0].app_version || ''));
// keyboard
ok('+ hidden while a card is open', await page.evaluate(() => getComputedStyle(document.getElementById('plus')).display === 'none'));
await page.setViewportSize({ width: 390, height: 420 });
await page.waitForTimeout(700);
const r = await page.evaluate(() => { const b = document.getElementById('card').getBoundingClientRect(); return { bottom: b.bottom, h: innerHeight, kb: document.documentElement.classList.contains('myos-kb') }; });
ok('keyboard class set on shrink', r.kb);
ok('card bottom within viewport after shrink (' + Math.round(r.bottom) + ' <= ' + r.h + ')', r.bottom <= r.h + 1 && r.bottom > r.h - 40);
// ---- v1.0.13 cases: no Capacitor bridge (served from a cache), keyboard races, version footer ----
{
  const page2 = await browser.newPage({ viewport: { width: 390, height: 800 } });
  const html2 = `<!doctype html><html><head><meta name=viewport content="width=device-width"></head><body style="margin:0">
<div id=app><div class=scroller id=scroller style="height:100vh;overflow:auto"><div class=content id=view>
<div style="height:1500px">calendar + rows</div>
<div class="row" id=last style="height:44px;background:#eee;transition:height .25s">Daily Inbox Zero<input id=t></div>
<p class=list-sub>my-os v1-p3</p></div></div></div>
<button id=plus>+</button><div id=scrim hidden></div>
<script>
window.nat = []; window.MyOSNative = { setTimer: (t, s) => nat.push(['setTimer', t, s]), clearTimer: () => nat.push(['clearTimer']), haptic: () => nat.push(['haptic']), refreshWidget: () => nat.push(['refreshWidget']) };
</script></body></html>`;
  await page2.route('https://v1.my-os.example.com/**', async route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/') return route.fulfill({ contentType: 'text/html', body: html2 });
    if (u.pathname === '/api/v1/state') return route.fulfill({ json: { timer: null, tasks: [] } });
    if (u.pathname === '/api/v1/timer') return route.fulfill({ json: { running: { task_id: 't9', title: 'Focus', started_at: new Date().toISOString() } } });
    return route.fulfill({ status: 404, body: '' });
  });
  await page2.goto('https://v1.my-os.example.com/');
  await page2.evaluate(shim);
  await page2.waitForTimeout(400);
  await page2.evaluate(() => fetch('/api/v1/timer', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ action: 'start', task_id: 't9' }) }));
  await page2.waitForTimeout(300);
  const nat = await page2.evaluate(() => nat);
  ok('no bridge: timer notification goes through MyOSNative', nat.some(c => c[0] === 'setTimer' && c[1] === 'Focus'));
  ok('no bridge: haptic goes through MyOSNative', await page2.evaluate(() => { myosShell.haptic('success'); return nat.some(c => c[0] === 'haptic'); }));
  ok('Settings footer shows the Android build', /Android test/.test(await page2.evaluate(() => document.querySelector('p.list-sub').textContent)));
  // Fast tap on the LAST row's title: focus first, keyboard shrinks the view, the card grows afterwards
  await page2.evaluate(() => { const r = document.getElementById('last'); r.scrollIntoView({ block: 'end' }); r.classList.add('open'); document.getElementById('t').focus(); });
  await page2.setViewportSize({ width: 390, height: 430 });
  await page2.waitForTimeout(150);
  await page2.evaluate(() => { document.getElementById('last').style.height = '300px'; });
  await page2.waitForTimeout(1500);
  const r2 = await page2.evaluate(() => { const b = document.getElementById('last').getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: innerHeight }; });
  ok('fast tap, last row: whole card above the keyboard after it grows (' + Math.round(r2.top) + '..' + Math.round(r2.bottom) + ' in ' + r2.h + ')', r2.top >= 0 && r2.bottom <= r2.h);
  await page2.close();
}
await browser.close();
