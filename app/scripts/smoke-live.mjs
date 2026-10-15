// Post-deploy smoke check against the live Worker, READ-ONLY: it only sends GETs, so it can never leave test rows in
// real data (the Oct 11-13 acceptance runs left "zz acceptance" to-dos behind). Write paths are covered by the local
// suites (test-v1-api, test-v1-ui) against SQLite; never add a live write here.
//   MYOS_BASE=https://my-os.example MYOS_AGENT_KEY=... node scripts/smoke-live.mjs
// Exits 1 on the first failed check. Prints counts and timestamps only, never task titles or mail.
const base = (process.env.MYOS_BASE || '').replace(/\/$/, ''), key = process.env.MYOS_AGENT_KEY || '';
if (!base || !key) { console.error('Set MYOS_BASE and MYOS_AGENT_KEY'); process.exit(2); }

let n = 0;
const check = (ok, msg) => { if (!ok) { console.error('FAIL', msg); process.exit(1); } n++; console.log('ok  ', msg); };
async function get(path) {
  const r = await fetch(base + path, { method: 'GET', headers: { authorization: 'Bearer ' + key } });
  let body = null; try { body = await r.json(); } catch (e) { /* not JSON */ }
  return { status: r.status, body };
}

const health = await get('/api/agent/health');
check(health.status === 200 && Array.isArray(health.body?.sources), 'GET /api/agent/health');
const tick = health.body.sources.find(s => s.source === 'cron_tick');
const age = tick && tick.last_ok ? (Date.now() - Date.parse(tick.last_ok)) / 60000 : Infinity;
// a deploy can pause crons for a while, so this is a warning, not a failure
console.log(age <= 30 ? `ok   cron_tick ${Math.round(age)} min ago` : `WARN cron_tick last ok ${tick ? tick.last_ok : 'never'} (${Math.round(age)} min)`);

const wake = await get('/api/agent/wake'); // GET only reads; the ack is a separate POST this script never sends
check(wake.status === 200 && typeof wake.body?.flag === 'boolean' && Array.isArray(wake.body?.changes), `GET /api/agent/wake (flag ${wake.body?.flag}, ${wake.body?.changes?.length} changes)`);

const tasks = await get('/api/agent/tasks');
check(tasks.status === 200, 'GET /api/agent/tasks');

const anon = await fetch(base + '/api/agent/health'); // no key: must be refused
check(anon.status === 401 || anon.status === 403, `agent API refuses a call without the key (${anon.status})`);

console.log(`smoke-live: ${n} checks passed`);
