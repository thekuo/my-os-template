// my-os v1 phase 0: data model, v0/v1 compat, areas/projects/headings, suggestions, Claude list, migration,
// v1 host routing. Runs the real Worker on an in-memory SQLite shim of D1 built the way prod gets it
// (schema before 0012 + the 0012 migration). No network, no real data. Run: node scripts/test-v1-api.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { buildEvents, dnum } from '../public/v1/model.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8');
const before = schema.replace(/^  start TEXT,\n[\s\S]*?^  created_via TEXT,\n/m, '').replace(/-- my-os v1 model[\s\S]*$/, '');
assert.ok(!/deadline TEXT/.test(before) && !before.includes('CREATE TABLE IF NOT EXISTS areas'), 'pre-0012 schema');
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(before);
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0012_v1_model.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0013_settings.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0014_event_labels.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0015_item_attachments.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0016_attachment_descriptions.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0017_attachment_note.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0018_attachment_files.sql'), 'utf-8'));

class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: (s) => new Stmt(s), batch: async (st) => { const o = []; for (const s of st) o.push(await s.run()); return o; } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const assetsSeen = [];
// ASSETS stub with Workers' default html_handling ("auto-trailing-slash"): /x/index.html -> 307 /x/
const env = { DB, APP_PASSPHRASE: 'dev', AGENT_KEY: 'k', INGEST_KEY: 'ik', ASSETS: { fetch: async (req) => {
  const p = new URL(req.url).pathname; assetsSeen.push(p);
  if (p.endsWith('/index.html')) return new Response(null, { status: 307, headers: { Location: p.slice(0, -10) } });
  return new Response('asset ' + p);
} } };
const worker = (await import('../src/index.js')).default;
const flush = async () => { while (pending.length) await pending.shift(); };

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };
async function call(method, p, body, headers = {}, host = 'my-os.test') {
  const res = await worker.fetch(new Request(`https://${host}${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await flush();
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}
const agent = (m, p, b) => call(m, p, b, { authorization: 'Bearer k' });
const form = new FormData(); form.set('passphrase', 'dev');
const login = await worker.fetch(new Request('https://my-os.test/login', { method: 'POST', body: form }), env, ctx);
const cookie = login.headers.get('set-cookie').split(';')[0];
const app = (m, p, b) => call(m, p, b, { cookie });
const row = (id) => sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const evN = (k) => sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(k).n;
let r;

// ---- seeded areas ----
r = await agent('GET', '/api/agent/areas');
eq(r.data.areas.map(a => a.title), ['Family', 'Health', 'Home', 'Money', 'Work', 'People']);

// ---- v1 fields on create ----
r = await agent('POST', '/api/agent/tasks', { title: 'Plan trip', start: 'anytime', area_id: 'a-family', flagged: true, deadline: '2026-11-30',
  checklist: ['Book flights', { title: 'Hotel', done: true }], tags: ['travel', 'Travel', 'errand'], reminder_at: '2026-11-01T17:00:00Z' });
eq(r.status, 201);
const trip = r.data.id;
let t = row(trip);
eq([t.due_date, t.inbox, t.start, t.flagged, t.deadline, t.area_id, t.area, t.created_via], [null, 0, 'anytime', 1, '2026-11-30', 'a-family', 'family', 'agent']);
r = await agent('GET', '/api/agent/tasks?status=open');
let d = r.data.tasks.find(x => x.id === trip);
eq([d.start, d.flagged, d.evening], ['anytime', true, false]);
eq(d.checklist.map(c => [c.title, c.done]), [['Book flights', false], ['Hotel', true]]);
eq(d.tags, ['errand', 'travel'], 'tags deduped case-insensitively');
eq(d.status, 'open');

r = await agent('POST', '/api/agent/tasks', { title: 'Tonight thing', start: 'date', start_date: '2026-10-12', evening: true });
eq([row(r.data.id).due_date, row(r.data.id).evening], ['2026-10-12', 1]);
r = await agent('POST', '/api/agent/tasks', { title: 'Inbox thing', start: 'inbox' });
eq([row(r.data.id).due_date, row(r.data.id).inbox], [null, 1]);
r = await agent('POST', '/api/agent/tasks', { title: 'Someday thing', start: 'someday' });
eq([row(r.data.id).due_date, row(r.data.id).start], [null, 'someday']);
r = await agent('POST', '/api/agent/tasks', { title: 'Old style' }); // v0 call: still defaults to today
ok(row(r.data.id).due_date, 'v0 default date kept');
for (const bad of [{ start: 'later' }, { start: 'date' }, { deadline: '2026-13-01' }, { flagged: 'yes' }, { evening: 1 }, { area_id: 'a-nope' },
  { checklist: 'x' }, { tags: ['x'.repeat(41)] }, { reminder_at: 'soon' }, { repeat: { freq: 'hourly' } }, { source: 'claude' }]) {
  r = await agent('POST', '/api/agent/tasks', { title: 'Bad', ...bad });
  eq(r.status, 400, JSON.stringify(bad));
}

// ---- repeat rule <-> v0 recurrence ----
r = await agent('POST', '/api/agent/tasks', { title: 'Weekdays rule', start: 'date', start_date: '2026-10-12', repeat: { freq: 'weekly', byweekday: [5, 1, 2, 3, 4] } });
t = row(r.data.id); eq(t.recurrence, 'weekdays'); eq(JSON.parse(t.repeat_rule), { mode: 'schedule', freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] });
r = await agent('POST', '/api/agent/tasks', { title: 'v0 monthly', recurrence: 'monthly', due_date: '2026-10-20', priority: 'P0' });
t = row(r.data.id); eq(JSON.parse(t.repeat_rule).freq, 'monthly'); eq(t.flagged, 0, 'repeating P0 is not flagged');
r = await agent('POST', '/api/agent/tasks', { title: 'v0 urgent', due_date: '2026-10-20', priority: 'P0', area: 'kids' });
t = row(r.data.id); eq([t.flagged, t.area_id], [1, 'a-family'], 'v0 P0 one-off -> flagged; kids -> Family');
const v0urgent = r.data.id;

// ---- v0 PATCH stays in sync ----
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { priority: 'P2' }); eq(row(v0urgent).flagged, 0);
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { area: 'finance' }); eq(row(v0urgent).area_id, 'a-money');
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { area_id: 'a-people' }); eq([row(v0urgent).area_id, row(v0urgent).area], ['a-people', null]);
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { backlog: true }); eq([row(v0urgent).due_date, row(v0urgent).start], [null, 'someday']);
r = await app('PATCH', `/api/tasks/${v0urgent}`, { due_date: '2026-10-25' }); eq(row(v0urgent).due_date, '2026-10-25');
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { start: 'inbox' }); eq([row(v0urgent).inbox, row(v0urgent).due_date], [1, null], 'start inbox via PATCH');
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { tags: ['x'] }); eq(r.status, 200, 'extras-only patch');
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { checklist: [] });
ok(!sqlite.prepare('SELECT 1 FROM checklist_items WHERE task_id = ?').get(v0urgent));
r = await agent('PATCH', `/api/agent/tasks/${v0urgent}`, { recurrence: 'daily', due_date: '2026-10-25' });
eq(JSON.parse(row(v0urgent).repeat_rule).freq, 'daily', 'v0 recurrence -> rule');

// ---- areas / projects / headings ----
r = await agent('POST', '/api/agent/areas', { title: 'Side project' }); eq(r.status, 201); const side = r.data.id;
r = await agent('PATCH', `/api/agent/areas/${side}`, { title: 'Side' }); eq(r.data.title, 'Side');
r = await agent('POST', '/api/agent/projects', { title: 'Home repairs', area_id: 'a-home', deadline: '2026-12-01' }); eq(r.status, 201); const proj = r.data.id;
r = await agent('POST', '/api/agent/projects', { title: 'x', area_id: 'a-nope' }); eq(r.status, 400);
r = await agent('POST', '/api/agent/headings', { project_id: proj, title: 'Kitchen' }); eq(r.status, 201); const head = r.data.id;
r = await agent('POST', '/api/agent/tasks', { title: 'Fix sink', project_id: proj, heading_id: head, start: 'anytime' });
eq(r.status, 201); t = row(r.data.id); eq([t.project_id, t.heading_id, t.area_id, t.area], [proj, head, 'a-home', 'house'], 'to-do takes the project area');
const sink = r.data.id;
r = await agent('POST', '/api/agent/headings', { project_id: 'p-nope', title: 'x' }); eq(r.status, 400);
r = await agent('POST', '/api/agent/projects', { title: 'Other' }); const other = r.data.id;
r = await agent('PATCH', `/api/agent/tasks/${sink}`, { heading_id: head, project_id: other }); eq(r.status, 400, 'heading must match project');
r = await agent('GET', '/api/agent/projects'); const pj = r.data.projects.find(p => p.id === proj);
eq(pj.headings.map(h => h.title), ['Kitchen']);
r = await agent('GET', '/api/agent/areas'); const home = r.data.areas.find(a => a.id === 'a-home');
eq([home.projects[0].title, home.projects[0].open_count], ['Home repairs', 1]);
r = await agent('PATCH', `/api/agent/projects/${proj}`, { area_id: 'a-money' });
eq([row(sink).area_id, row(sink).area], ['a-money', 'finance'], 'moving a project moves its to-dos');
r = await agent('PATCH', `/api/agent/projects/${proj}`, { status: 'completed' }); ok(r.data.completed_at); eq(evN('project_completed'), 1);
r = await agent('GET', '/api/agent/projects'); ok(!r.data.projects.some(p => p.id === proj), 'completed projects leave the open list');
r = await agent('PATCH', `/api/agent/tasks/${sink}`, { project_id: null }); eq([row(sink).project_id, row(sink).heading_id], [null, null]);

// ---- suggestions in the Inbox ----
r = await agent('POST', '/api/agent/tasks', { title: 'Renew passports', source: 'claude', reason: 'Expires in March' });
eq(r.status, 201); const sug = r.data.id;
t = row(sug); eq([t.inbox, t.due_date, t.source, t.reason, t.suggestion_state], [1, null, 'claude', 'Expires in March', 'pending']);
r = await agent('POST', '/api/agent/tasks', { title: 'renew passports', source: 'claude', reason: 'again' }); eq(r.status, 409);
r = await agent('GET', '/api/agent/tasks?status=suggestions'); ok(r.data.tasks.some(x => x.id === sug));
r = await agent('GET', '/api/agent/tasks?status=open'); ok(!r.data.tasks.some(x => x.id === sug), 'pending suggestions are not open tasks');
r = await agent('GET', '/api/agent/tasks?status=inbox'); ok(!r.data.tasks.some(x => x.id === sug));
r = await app('GET', '/api/tasks'); ok(!r.data.tasks.some(x => x.id === sug), 'v0 app never shows suggestions');
r = await agent('PATCH', `/api/agent/tasks/${sug}`, { suggestion_state: 'accepted' }); eq(evN('suggestion_accepted'), 1);
r = await agent('GET', '/api/agent/tasks?status=inbox'); ok(r.data.tasks.some(x => x.id === sug), 'accepted -> a real Inbox to-do');
r = await agent('POST', '/api/agent/tasks', { title: 'Call plumber', source: 'claude', reason: 'Leak' }); const sug2 = r.data.id;
r = await agent('PATCH', `/api/agent/tasks/${sug2}`, { suggestion_state: 'dismissed' }); eq(evN('suggestion_dismissed'), 1);
r = await agent('POST', '/api/agent/tasks', { title: 'Call plumber', source: 'claude', reason: 'Leak' }); eq(r.status, 409, 'dismissed: no re-suggest for 14 days');
eq(r.data.duplicate_of, sug2);
r = await agent('PATCH', `/api/agent/tasks/${sug2}`, { suggestion_state: 'maybe' }); eq(r.status, 400);

// ---- Claude list ----
r = await agent('POST', '/api/agent/tasks', { title: 'Send weekly review', list: 'Claude', due_date: '2026-10-16' }); eq(r.status, 201); const cl = r.data.id;
r = await agent('GET', '/api/agent/tasks?status=claude'); eq(r.data.tasks.map(x => x.id), [cl]);
r = await agent('GET', '/api/agent/tasks?status=open'); ok(!r.data.tasks.some(x => x.id === cl), 'Claude list is not in open');
r = await app('GET', '/api/tasks'); ok(!r.data.tasks.some(x => x.id === cl), 'v0 app never shows the Claude list');
r = await agent('GET', '/api/agent/snapshot');
{ const snap = r.data, cl = snap.indexOf('## Claude list');
  ok(r.status === 200 && cl > 0 && snap.indexOf('Send weekly review') > cl && snap.indexOf('Send weekly review') === snap.lastIndexOf('Send weekly review'), 'Claude list only in its own section');
  ok(!snap.includes('Call plumber'), 'dismissed suggestions hidden');
  ok(/## Projects \(open\) \(\d+\)/.test(snap) && /- Other \(0 open\)/.test(snap), 'projects section');
  ok(snap.includes('## Claude suggestions waiting in Inbox'), 'suggestions section'); }
r = await agent('PATCH', `/api/agent/tasks/${cl}`, { completed: true }); eq(r.status, 200); ok(row(cl).completed_at);

// ---- migration: dry run + apply on v0-shaped rows ----
const ins = sqlite.prepare("INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, area, inbox, completed_at, dropped_at, created_at, updated_at) VALUES (?, 'owner', ?, 'x', ?, ?, ?, ?, ?, ?, ?, '2026-10-01', '2026-10-01')");
ins.run('m-1', 'Tasks', 'P0', '2026-10-20', null, 'kids', 0, null, null);       // flagged, Family
ins.run('m-2', 'Tasks', 'P0', '2026-10-20', 'daily', 'health', 0, null, null);  // repeating P0: not flagged
ins.run('m-3', 'Birthdays', 'P2', '2026-11-02', 'yearly', 'family', 0, null, null); // People wins
ins.run('m-4', 'Tasks', 'P2', null, null, 'house', 0, null, null);              // undated -> Someday
ins.run('m-5', 'Tasks', 'P2', null, null, null, 0, null, null);                 // untagged undated -> Inbox
ins.run('m-6', 'Tasks', 'P2', '2026-10-15', null, null, 0, null, null);         // untagged dated keeps date
ins.run('m-7', 'Tasks', 'P1', '2026-10-01', null, 'venture', 0, null, '2026-10-02'); // canceled -> Logbook, Work
ins.run('m-8', 'Tasks', 'P1', '2026-10-01', null, 'finance', 0, '2026-10-02', null); // completed -> Logbook, Money
ins.run('m-9', 'Tasks', 'P2', null, null, null, 1, null, null);                 // quick-add Inbox stays Inbox
const before9 = sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
r = await agent('POST', '/api/agent/v1/migrate?dry_run=1', { deadlines: { 'm-1': '2026-10-31', 'm-nope': '2026-10-31' }, projects: [{ title: 'School', area: 'kids', task_ids: ['m-1', 'nope'] }] });
eq(r.status, 200); eq(r.data.dry_run, true);
ok(r.data.summary.date && r.data.summary.inbox && r.data.summary.someday && r.data.summary.logbook_canceled && r.data.summary.logbook_completed);
eq(r.data.deadlines, 1); eq(r.data.projects, [{ title: 'School', area_id: 'a-family', tasks: 1 }]);
eq(row('m-1').area_id, null, 'dry run writes nothing'); eq(sqlite.prepare('SELECT COUNT(*) AS n FROM migration_log').get().n, 0);
r = await agent('POST', '/api/agent/v1/migrate?dry_run=0', { deadlines: { 'm-1': '2026-10-31' }, projects: [{ title: 'School', area: 'Family', task_ids: ['m-1'] }] });
eq(r.data.dry_run, false);
eq([row('m-1').flagged, row('m-1').area_id, row('m-1').deadline], [1, 'a-family', '2026-10-31']);
ok(row('m-1').project_id && sqlite.prepare('SELECT title FROM projects WHERE id = ?').get(row('m-1').project_id).title === 'School');
eq(row('m-2').flagged, 0);
eq(row('m-3').area_id, 'a-people');
eq([row('m-4').start, row('m-4').due_date], ['someday', null]);
eq(row('m-5').inbox, 1);
eq([row('m-6').due_date, row('m-6').inbox, row('m-6').area_id], ['2026-10-15', 0, null]);
eq(row('m-7').area_id, 'a-work'); eq(row('m-8').area_id, 'a-money'); eq(row('m-9').inbox, 1);
ok(sqlite.prepare("SELECT COUNT(*) AS n FROM migration_log WHERE task_id = 'm-1'").get().n >= 5, 'logged');
r = await agent('POST', '/api/agent/v1/migrate?dry_run=1', {});
eq(r.data.to_migrate, 0, 'idempotent: everything already migrated');
eq(sqlite.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, before9, 'no rows added or removed');
r = await call('POST', '/api/agent/v1/migrate?dry_run=1', {}, { authorization: 'Bearer ik' }); eq(r.status, 403, 'ingest key cannot migrate');
r = await agent('GET', '/api/agent/snapshot');
{ const today = r.data.match(/Today is (\d{4}-\d{2}-\d{2})/)[1];
  const add = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  await agent('POST', '/api/agent/tasks', { title: 'Snap today', start: 'date', start_date: today, evening: true, flagged: true, deadline: add(today, 2), project_id: other });
  await agent('POST', '/api/agent/tasks', { title: 'Snap later', start: 'anytime', deadline: add(today, 5) });
  r = await agent('GET', '/api/agent/snapshot');
  ok(r.data.includes(`Snap today (due ${today}; flagged; this evening; deadline ${add(today, 2)}; project: Other)`), 'v1 bits on a Today line');
  const dl = r.data.slice(r.data.indexOf('## Deadlines'), r.data.indexOf('## Projects'));
  ok(dl.includes(`Snap later (deadline ${add(today, 5)})`) && !dl.includes('Snap today'), 'deadline section lists only to-dos not already shown'); }

// ---- v1 host routing ----
assetsSeen.length = 0;
await call('GET', '/', undefined, { cookie }, 'v1.my-os.test');
await call('GET', '/today', undefined, { cookie }, 'v1.my-os.test');
await call('GET', '/app.css', undefined, { cookie }, 'v1.my-os.test');
await call('GET', '/', undefined, { cookie }, 'my-os.test');
eq(assetsSeen, ['/v1/', '/v1/', '/v1/app.css', '/'], 'v1 host serves public/v1, SPA fallback');
r = await call('GET', '/api/tasks', undefined, { cookie }, 'v1.my-os.test'); eq(r.status, 200, 'same API on the v1 host');
r = await call('GET', '/', undefined, {}, 'v1.my-os.test'); eq(r.status, 401, 'login required on v1 too');
// v1 host + login, following redirects like a browser: no loop, never a /v1 URL (regression: ERR_TOO_MANY_REDIRECTS)
{ const get = async (p, headers) => worker.fetch(new Request('https://v1.my-os.test' + p, { headers, redirect: 'manual' }), env, ctx);
  const fd = new FormData(); fd.set('passphrase', 'dev');
  const lr = await worker.fetch(new Request('https://v1.my-os.test/login', { method: 'POST', body: fd }), env, ctx);
  eq([lr.status, lr.headers.get('location')], [302, '/'], 'login on the v1 host redirects to /');
  const ck = lr.headers.get('set-cookie').split(';')[0];
  let p = '/', hops = 0, res;
  for (;;) { res = await get(p, { cookie: ck }); if (res.status < 300 || res.status >= 400) break; p = new URL(res.headers.get('location'), 'https://v1.my-os.test').pathname; ok(!p.startsWith('/v1'), 'no /v1 URL'); if (++hops > 3) break; }
  eq([res.status, hops], [200, 0], 'v1 page loads with no redirects');
  for (const q of ['/today', '/v1/', '/v1/index.html', '/index.html']) { res = await get(q, { cookie: ck }); ok(res.status === 200, 'no redirect for ' + q); }
  res = await get('/app.js', { cookie: ck }); eq(await res.text(), 'asset /v1/app.js');
  res = await get('/', {}); eq(res.status, 401, 'signed out: login page, no redirect'); }
env.V1_HOSTS = 'my-os.test'; assetsSeen.length = 0;
await call('GET', '/', undefined, { cookie }, 'my-os.test'); eq(assetsSeen, ['/v1/'], 'cutover by V1_HOSTS');
delete env.V1_HOSTS;

// ---- v1 app API (cookie) ----
r = await call('GET', '/api/v1/state'); eq(r.status, 401, 'state needs the session');
r = await app('POST', '/api/v1/tasks', { title: '  Buy milk ' }); eq(r.status, 201);
const milk = r.data.id; eq([r.data.title, r.data.start, row(milk).inbox, row(milk).created_via], ['Buy milk', 'inbox', 1, 'app'], 'nothing chosen -> Inbox');
r = await app('POST', '/api/v1/tasks', { title: 'Tonight', start: 'date', start_date: '2026-10-12', evening: true, area_id: 'a-home', flagged: true });
const tonight = r.data.id; t = row(tonight);
eq([t.due_date, t.evening, t.area, t.flagged, t.priority], ['2026-10-12', 1, 'house', 1, 'P0'], 'v1 flag reads as P0 in v0');
r = await app('POST', '/api/v1/tasks', { title: '' }); eq(r.status, 400);
r = await app('POST', '/api/v1/tasks', { title: 'x', source: 'claude', reason: 'y' }); eq(r.status, 400, 'app cannot create suggestions');
r = await app('PATCH', `/api/v1/tasks/${tonight}`, { flagged: false }); eq([row(tonight).flagged, row(tonight).priority], [0, 'P2']);
r = await app('PATCH', `/api/v1/tasks/${milk}`, { start: 'anytime', area_id: 'a-health', today_index: 3 });
eq([r.data.start, r.data.area_id, r.data.today_index, row(milk).inbox], ['anytime', 'a-health', 3, 0]);
r = await app('PATCH', `/api/v1/tasks/${milk}`, { completed: true }); eq(r.data.status, 'completed');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { completed: false }); eq(r.data.status, 'open', 'undo complete');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { canceled: true }); eq(r.data.status, 'canceled');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { canceled: false }); eq(r.data.status, 'open', 'undo cancel');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { trashed: true }); eq(r.data.status, 'trashed'); eq(evN('task_trashed'), 1);
r = await app('GET', '/api/tasks'); ok(!r.data.tasks.some(x => x.id === milk), 'trash hidden from v0');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { trashed: false }); eq(r.data.status, 'open');
r = await app('PATCH', `/api/v1/tasks/${milk}`, { completed: 'yes' }); eq(r.status, 400);
r = await app('PATCH', '/api/v1/tasks/t-nope', { title: 'x' }); eq(r.status, 404);
// repeating: complete advances and undo puts it back; cancel skips one occurrence
r = await app('POST', '/api/v1/tasks', { title: 'Daily thing', start: 'date', start_date: '2030-01-10', repeat: { freq: 'daily' } }); const daily = r.data.id;
r = await app('PATCH', `/api/v1/tasks/${daily}`, { completed: true }); eq([r.data.status, r.data.start_date], ['open', '2030-01-11']);
r = await app('PATCH', `/api/v1/tasks/${daily}`, { completed: false }); eq(r.data.start_date, '2030-01-10');
r = await app('PATCH', `/api/v1/tasks/${daily}`, { canceled: true }); eq([r.data.status, r.data.start_date], ['open', '2030-01-11'], 'cancel = skip this occurrence');
{ // v1 repeat rules: late completion jumps past today; end after N; after-completion mode; a repeat on an undated to-do starts today
  const today = (await app('GET', '/api/v1/state')).data.today;
  const add = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  r = await app('POST', '/api/v1/tasks', { title: 'Late daily', start: 'date', start_date: add(today, -3), repeat: { freq: 'daily' } });
  r = await app('PATCH', `/api/v1/tasks/${r.data.id}`, { completed: true }); eq(r.data.start_date, add(today, 1), 'late: next after today');
  eq(r.data.repeat.anchor, add(today, -3), 'anchor kept');
  r = await app('POST', '/api/v1/tasks', { title: 'Three times', start: 'date', start_date: today, repeat: { freq: 'daily', end: { after: 2 } } }); const three = r.data.id;
  r = await app('PATCH', `/api/v1/tasks/${three}`, { completed: true }); eq(r.data.status, 'open');
  r = await app('PATCH', `/api/v1/tasks/${three}`, { completed: true }); eq(r.data.status, 'completed', 'series ends after 2');
  r = await app('PATCH', `/api/v1/tasks/${three}`, { completed: false }); eq([r.data.status, r.data.start_date], ['open', add(today, 1)], 'undo reopens the last one');
  r = await app('POST', '/api/v1/tasks', { title: 'Every 2 weeks after', start: 'date', start_date: add(today, 5), repeat: { mode: 'after', freq: 'weekly', interval: 2 } });
  r = await app('PATCH', `/api/v1/tasks/${r.data.id}`, { completed: true }); eq(r.data.start_date, add(today, 14), 'after completion: from today');
  r = await app('POST', '/api/v1/tasks', { title: 'Undated repeat', start: 'anytime', repeat: { freq: 'weekly' } }); eq([r.data.start, r.data.start_date], ['date', today]);
  r = await app('POST', '/api/v1/tasks', { title: 'Undated then repeat', start: 'someday' });
  r = await app('PATCH', `/api/v1/tasks/${r.data.id}`, { repeat: { freq: 'monthly' } }); eq([r.data.start, r.data.start_date, r.data.recurrence], ['date', today, 'monthly']);
  r = await app('PATCH', `/api/v1/tasks/${r.data.id}`, { repeat: null }); eq([r.data.repeat, r.data.recurrence], [null, null], 'repeat removed');
}
// suggestion accept/dismiss and undo back to pending
r = await agent('POST', '/api/agent/tasks', { title: 'Try the new clinic', source: 'claude', reason: 'Closer' }); const sug3 = r.data.id;
r = await app('PATCH', `/api/v1/tasks/${sug3}`, { suggestion_state: 'dismissed' }); eq(row(sug3).suggestion_state, 'dismissed');
r = await app('PATCH', `/api/v1/tasks/${sug3}`, { suggestion_state: 'pending' }); eq(row(sug3).suggestion_state, 'pending', 'undo dismiss');
// state
{ // calendar + brief fixtures
  const now = new Date(); const iso = (h) => new Date(now.getTime() + h * 3600000).toISOString();
  sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, title, status, first_seen, last_seen) VALUES ('owner', 'primary', 'e1', ?, ?, 0, 'Lunch', 'confirmed', ?, ?)").run(iso(1), iso(2), iso(0), iso(0));
  sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, title, status, first_seen, last_seen, removed_at) VALUES ('owner', 'primary', 'e2', ?, ?, 0, 'Gone', 'confirmed', ?, ?, ?)").run(iso(1), iso(2), iso(0), iso(0), iso(0));
  sqlite.prepare("INSERT INTO briefs (id, tenant_id, date, body_md, created_at) VALUES ('b1', 'owner', '2000-01-01', '# Brief\n\nHello', ?)").run(iso(0));
}
r = await app('GET', '/api/v1/state'); eq(r.status, 200);
const st = r.data;
ok(st.today && st.tz && Array.isArray(st.tasks) && Array.isArray(st.completions));
ok(st.tasks.some(x => x.id === sug3 && x.suggestion_state === 'pending'), 'pending suggestions included');
ok(st.tasks.some(x => x.id === cl && x.status === 'completed'), 'Claude list incl. done');
ok(!st.tasks.some(x => x.id === sug2), 'dismissed suggestions excluded');
ok(st.tasks.some(x => x.id === 'm-7' && x.status === 'canceled'), 'Logbook: canceled');
ok(st.completions.some(c => c.task_id === daily) === false, 'undone completion removed');
eq(st.areas.length, 7);
ok(st.projects.some(p => p.id === proj && p.status === 'completed' && p.headings.length === 1));
eq(st.events.map(e => e.title), ['Lunch'], 'removed events excluded');
eq(st.brief.body_md, '# Brief\n\nHello');
ok(st.tasks.find(x => x.id === 'm-5').area_id === null);
sqlite.prepare("INSERT INTO tasks (id, tenant_id, list, title, area, created_at, updated_at) VALUES ('m-raw', 'owner', 'Birthdays', 'x', 'family', '2026-10-01', '2026-10-01')").run();
r = await app('GET', '/api/v1/state'); eq(r.data.tasks.find(x => x.id === 'm-raw').area_id, 'a-people', 'unmigrated rows map areas');
// structure from the app
r = await app('POST', '/api/v1/projects', { title: 'New project', area_id: 'a-work' }); eq(r.status, 201); eq(evN('project_created'), 3);
r = await app('PATCH', `/api/v1/projects/${r.data.id}`, { title: 'Renamed' }); eq(r.data.title, 'Renamed');
r = await app('POST', '/api/v1/areas', { title: 'Garden' }); eq(r.status, 201);
// feedback
r = await app('POST', '/api/v1/feedback', { note: 'Rows feel tight', screen: 'today', app_version: 'v1-test' }); eq(r.status, 201); const fb = r.data.id;
r = await app('POST', '/api/v1/feedback', {}); eq(r.status, 400);
r = await app('POST', '/api/v1/feedback', { note: 'x', screenshot: 'javascript:1' }); eq(r.status, 400);
r = await app('POST', '/api/v1/feedback', { screenshot: 'data:image/jpeg;base64,AAAA', screen: 'inbox' }); eq(r.status, 201); const fb2 = r.data.id;
r = await agent('GET', '/api/agent/feedback'); eq(r.data.count, 2); ok(!('screenshot' in r.data.feedback[0])); eq(r.data.feedback.find(f => f.id === fb).has_screenshot, false);
r = await agent('GET', `/api/agent/feedback/${fb2}/screenshot`); eq(r.data.screenshot, 'data:image/jpeg;base64,AAAA');
r = await agent('GET', `/api/agent/feedback/${fb}/screenshot`); eq(r.status, 404);
r = await call('GET', '/api/agent/feedback', undefined, { cookie }); eq(r.status, 401, 'agent feedback needs the agent key');
eq(evN('feedback_sent'), 2);
r = await app('GET', '/api/v1/nope'); eq(r.status, 404);

// ---- anomaly feed (COS-NEEDS §4: a cancel and a 3x-postponed to-do) ----
{ const t0 = new Date().toISOString();
  r = await app('POST', '/api/v1/tasks', { title: 'Keeps slipping', start: 'date', start_date: '2026-10-12' }); const slip = r.data.id;
  for (const d of ['2026-10-13', '2026-10-15', '2026-10-11', '2026-10-20']) await app('PATCH', `/api/v1/tasks/${slip}`, { start: 'date', start_date: d });
  await app('PATCH', `/api/v1/tasks/${slip}`, { start: 'someday' });
  r = await app('POST', '/api/v1/tasks', { title: 'Dropped one', start: 'anytime' }); await app('PATCH', `/api/v1/tasks/${r.data.id}`, { canceled: true });
  r = await app('POST', '/api/v1/tasks', { title: 'Deleted one', start: 'anytime' }); await app('PATCH', `/api/v1/tasks/${r.data.id}`, { trashed: true });
  r = await app('POST', '/api/v1/tasks', { title: 'Late one', start: 'anytime', deadline: '2026-01-05' }); await app('PATCH', `/api/v1/tasks/${r.data.id}`, { completed: true });
  r = await agent('GET', '/api/agent/anomalies?since=' + encodeURIComponent(t0));
  eq(r.status, 200);
  const a = r.data;
  ok(a.cancels.some(c => c.title === 'Dropped one' && c.kind === 'canceled' && c.via === 'v1'), 'cancel listed');
  ok(a.deletes.some(c => c.title === 'Deleted one' && c.still_deleted), 'delete listed');
  const p3 = a.postponed_3x.find(x => x.title === 'Keeps slipping');
  ok(p3 && p3.times === 4, 'postponed 4 times (the move earlier does not count)');
  eq(a.reschedules.filter(x => x.title === 'Keeps slipping').length, 5);
  ok(a.reschedules.some(x => x.title === 'Keeps slipping' && x.from === '2026-10-15' && x.to === '2026-10-11' && !x.postponed), 'pulled earlier is not a postponement');
  const late = a.late_completions.find(x => x.title === 'Late one'); ok(late && late.days_late > 200, 'late completion');
  eq(a.counts.late_completions, a.late_completions.length);
  r = await agent('GET', '/api/agent/anomalies?since=nope'); eq(r.status, 400);
  r = await agent('GET', '/api/agent/anomalies?since=2099-01-01T00:00:00Z'); eq(r.data.counts, { cancels: 0, deletes: 0, reschedules: 0, postponed_3x: 0, late_completions: 0 });
  r = await call('GET', '/api/agent/anomalies', undefined, { authorization: 'Bearer ik' }); eq(r.status, 403); }

// ---- settings ----
r = await app('GET', '/api/v1/settings'); eq(r.data.work_start, 480); eq(r.data.cals.work, true);
r = await app('PUT', '/api/v1/settings', { work_start: 540, free_lines: false, cals: { family: true, personal: false, work: true } });
eq([r.data.work_start, r.data.work_end, r.data.free_lines, r.data.cals.personal], [540, 1065, false, false]);
r = await agent('GET', '/api/agent/settings'); eq(r.data.work_start, 540, 'CoS reads the work schedule');
r = await app('GET', '/api/v1/state'); eq(r.data.settings.free_lines, false);
for (const bad of [{ work_start: 'x' }, { nope: 1 }, { work_end: 300 }, {}, { cals: { Family: true } }]) { r = await app('PUT', '/api/v1/settings', bad); eq(r.status, 400, JSON.stringify(bad)); }
eq(evN('settings_changed') >= 1, true);

// ---- timer ----
r = await app('POST', '/api/v1/tasks', { title: 'Timed one', start: 'anytime' }); const timed = r.data.id;
r = await app('POST', '/api/v1/tasks', { title: 'Timed two', start: 'anytime' }); const timed2 = r.data.id;
r = await app('POST', '/api/v1/timer', { action: 'start', task_id: timed }); eq(r.data.running.task_id, timed); eq(r.data.stopped, null);
sqlite.prepare('UPDATE time_entries SET started_at = ? WHERE task_id = ? AND stopped_at IS NULL').run(new Date(Date.now() - 31 * 60000).toISOString(), timed);
r = await app('POST', '/api/v1/timer', { action: 'start', task_id: timed2 }); eq([r.data.stopped.task_id, r.data.stopped.seconds >= 1860], [timed, true], 'starting another stops the first');
r = await app('GET', '/api/v1/state'); eq(r.data.timer.task_id, timed2); ok(r.data.time[timed] >= 1860);
r = await app('PATCH', `/api/v1/tasks/${timed2}`, { completed: true }); ok(sqlite.prepare('SELECT stopped_at FROM time_entries WHERE task_id = ?').get(timed2).stopped_at, 'completing stops the timer');
r = await app('GET', '/api/v1/state'); eq(r.data.timer, null);
r = await app('POST', '/api/v1/timer', { action: 'start', task_id: timed2 }); eq(r.status, 404, 'cannot time a completed to-do');
r = await app('POST', '/api/v1/timer', { action: 'start', task_id: timed }); r = await app('PATCH', `/api/v1/tasks/${timed}`, { trashed: true }); eq((await app('GET', '/api/v1/state')).data.timer, null, 'deleting stops it');
r = await app('POST', '/api/v1/timer', { action: 'stop' }); eq(r.data.stopped, null, 'stop with nothing running');
r = await app('POST', '/api/v1/timer', { action: 'pause' }); eq(r.status, 400);
sqlite.prepare("INSERT INTO time_entries (id, tenant_id, task_id, started_at) VALUES ('te-old', 'owner', ?, ?)").run(timed2, new Date(Date.now() - 30 * 3600000).toISOString());
r = await app('POST', '/api/v1/timer', { action: 'stop' }); eq(r.data.stopped.seconds, 12 * 3600, 'a forgotten timer is capped at 12h');
r = await agent('GET', '/api/agent/time');
ok(r.data.by_task.find(x => x.task_id === timed).seconds >= 1860 && r.data.entries.length >= 4 && r.data.running === null, 'CoS time read');
eq(evN('timer_started'), 3);

// ---- wake (pull mode) ----
{ const iso = (h) => new Date(Date.now() + h * 3600000).toISOString();
  r = await agent('GET', '/api/agent/wake'); eq([r.data.flag, r.data.schedule.every_minutes], [false, 60]);
  await app('PUT', '/api/v1/settings', { checkins: { every_minutes: 60, start: '00:00', end: '23:59' } }); // no quiet hours, whatever time the test runs
  const ML = sqlite.prepare("INSERT INTO mail_messages (tenant_id, msg_id, thread_id, ts, direction, from_addr, from_name, subject, category, list_unsubscribe, labels, first_seen, last_seen) VALUES ('owner', ?, 'th', ?, 'in', ?, 'Pat', ?, ?, ?, ?, ?, ?)");
  const M = { run: (id, ts, from, subj, cat, lu, fs, ls, labels = '["UNREAD","CATEGORY_PERSONAL","INBOX"]') => ML.run(id, ts, from, subj, cat, lu, labels, fs, ls) };
  M.run('m1', iso(-1), 'pat@example.com', 'Can you confirm Friday?', 'primary', 0, iso(-1), iso(-1));
  M.run('m2', iso(-1), 'no-reply+abc@school.example', 'Class update', 'primary', 0, iso(-1), iso(-1));                         // automated, Primary inbox: wakes, bulk
  M.run('m2b', iso(-1), 'registration@rec.example', 'Registration confirmed', 'primary', 1, iso(-1), iso(-1));                  // mailing list, Primary inbox: wakes, bulk
  M.run('m2c', iso(-1), 'registration@rec.example', 'Class reminder', 'updates', 1, iso(-1), iso(-1), '["IMPORTANT","CATEGORY_UPDATES","INBOX"]'); // Updates but Important: wakes
  M.run('m2d', iso(-1), 'em@store.example', 'Shipping', 'updates', 1, iso(-1), iso(-1), '["CATEGORY_UPDATES","INBOX"]');        // Updates, not Important: no
  M.run('m2e', iso(-1), 'pat@example.com', 'Archived', 'primary', 0, iso(-1), iso(-1), '["CATEGORY_PERSONAL"]');                // Primary, read and archived: still wakes
  M.run('m2g', iso(-1), 'a@rec.example', 'Receipt', 'primary', 1, iso(-1), iso(-1), '["IMPORTANT","CATEGORY_PERSONAL"]');       // Primary, Important, archived: wakes, bulk
  M.run('m2h', iso(-1), 'a@rec.example', 'Old notice', 'updates', 1, iso(-1), iso(-1), '["IMPORTANT","CATEGORY_UPDATES"]');     // Updates + Important but archived: no
  M.run('m2f', iso(-1), 'x@spam.example', 'Win', 'primary', 0, iso(-1), iso(-1), '["CATEGORY_PERSONAL","SPAM"]');               // spam: no
  M.run('m3', iso(-1), 'news@example.com', 'Weekly digest', 'promotions', 1, iso(-1), iso(-1));
  M.run('m-own', iso(-1), 'me@example.com', 'Re: plans', 'primary', 0, iso(-1), iso(-1));
  M.run('m-future', iso(5), 'pat@example.com', 'Scheduled send', 'primary', 0, iso(-1), iso(-1));
  sqlite.prepare("INSERT INTO mail_messages (tenant_id, msg_id, thread_id, ts, direction, from_addr, subject, category, labels, first_seen, last_seen) VALUES ('owner', 'm-sent', 'th', ?, 'in', 'x@example.com', 'Sent copy', 'primary', '[\"SENT\",\"INBOX\"]', ?, ?)").run(iso(-1), iso(-1), iso(-1));
  env.OWN_ADDRESSES = 'Me@example.com';
  const C = sqlite.prepare("INSERT INTO calendar_changes (id, tenant_id, calendar_id, event_id, kind, at, before, after) VALUES (?, 'owner', 'primary', ?, ?, ?, ?, ?)");
  C.run('cc1', 'ev-soon', 'changed', iso(-0.5), JSON.stringify({ title: 'Dentist', start_ts: iso(20) }), JSON.stringify({ title: 'Dentist', start_ts: iso(30) }));
  C.run('cc2', 'ev-far', 'added', iso(-0.5), null, JSON.stringify({ title: 'Conference', start_ts: iso(24 * 10) }));
  sqlite.prepare("INSERT INTO items (id, tenant_id, source, ext_id, ts, title, meta, first_seen, last_seen) VALUES ('i-1', 'owner', 'beeper', 'x1', ?, 'Sam', ?, ?, ?)").run(iso(-0.2), JSON.stringify({ chat_id: 'c-sam', direction: 'in', sender: 'Sam' }), iso(0), iso(0));
  env.WAKE_VIP = 'sam';
  r = await agent('GET', '/api/agent/wake');
  eq(r.data.flag, true); eq(r.data.changes.map(c => c.kind + ':' + c.id).sort(), ['calendar:ev-soon', 'chat:c-sam', 'mail:m1', 'mail:m2', 'mail:m2b', 'mail:m2c', 'mail:m2e', 'mail:m2g'], 'Primary mail (archived too) or inbox Important, bulk included; events within 48h; VIP chats');
  eq(r.data.changes.filter(c => c.kind === 'mail').map(c => c.id + ':' + c.bulk).join(','), 'm1:false,m2:true,m2b:true,m2c:true,m2e:false,m2g:true', 'automated / list mail marked bulk');
  ok(!JSON.stringify(r.data).includes('snippet') && r.data.changes.find(c => c.kind === 'mail').title === 'Can you confirm Friday?');
  r = await agent('POST', '/api/agent/wake/ack', {}); ok(r.data.ok);
  r = await agent('GET', '/api/agent/wake'); eq([r.data.flag, r.data.changes.length], [false, 0], 'ack clears');
  r = await agent('POST', '/api/agent/wake/ack', { at: 'nope' }); eq(r.status, 400);
  // schedule from the "Claude check-ins" setting; quiet hours and the daily cap hold the flag
  r = await app('PUT', '/api/v1/settings', { checkins: { every_minutes: 30, start: '07:00', end: '22:00' } }); eq(r.status, 400, 'minimum 60');
  r = await app('PUT', '/api/v1/settings', { checkins: { every_minutes: 0, start: '00:00', end: '23:59' } }); eq(r.status, 400);
  r = await app('PUT', '/api/v1/settings', { checkins: { every_minutes: 120, start: '00:00', end: '23:59' } }); eq(r.status, 200);
  M.run('m4', iso(0), 'pat@example.com', 'One more', 'primary', 0, iso(0), iso(0));
  r = await agent('GET', '/api/agent/wake'); eq([r.data.flag, r.data.schedule.every_minutes, r.data.quiet], [true, 120, false]);
  const W = sqlite.prepare("INSERT INTO wake_log (id, at, kinds, ids, status) VALUES (?, ?, 'mail', 'x', 'ack')");
  for (let i = 0; i < 8; i++) W.run('w-cap' + i, new Date().toISOString());
  r = await agent('GET', '/api/agent/wake'); eq([r.data.flag, r.data.capped, r.data.changes.length], [false, true, 1], 'capped at 8 a day; changes still listed');
  sqlite.prepare("DELETE FROM wake_log WHERE id LIKE 'w-cap%'").run();
  r = await app('PUT', '/api/v1/settings', { checkins: { every_minutes: 60, start: '00:00', end: '00:01' } });
  r = await agent('GET', '/api/agent/wake'); eq([r.data.flag, r.data.quiet], [false, true], 'quiet outside the check-in window');
  delete env.WAKE_VIP; delete env.OWN_ADDRESSES; }

// ---- event labels for free/busy blocks (approximate times: overlap match) ----
{ const tz = 'America/Los_Angeles';
  const local = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(d).map(x => [x.type, x.value]));
  const hm = (d, plus = 0) => { const p = local(new Date(d.getTime() + plus * 60000)); return `${p.hour}:${p.minute}`; };
  // a block tomorrow 10:00-11:00 LA (busy), another 14:00-14:30; local times built from a fixed LA date
  const day = local(new Date(Date.now() + 86400000)), date = `${day.year}-${day.month}-${day.day}`;
  const at = (h, m) => { for (const off of [7, 8]) { const d = new Date(`${date}T${String(h + off).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); if (hm(d) === `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) return d; } };
  const E = sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, title, status, first_seen, last_seen) VALUES ('owner', 'work@x', ?, ?, ?, 0, NULL, 'busy', ?, ?)");
  const now = new Date().toISOString();
  E.run('fb1', at(10, 0).toISOString(), at(11, 0).toISOString(), now, now);
  E.run('fb2', at(14, 0).toISOString(), at(14, 30).toISOString(), now, now);
  E.run('fb3', at(16, 0).toISOString(), at(17, 0).toISOString(), now, now);
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(day.weekday);
  r = await agent('POST', '/api/agent/event-labels', { labels: [
    { date, approx_start: '09:50', title: 'Team sync' },          // 10 min early: still this block
    { date, approx_start: '10:30', title: 'Design review' },      // merged back-to-back: same block
    { recurring: true, weekday: wd, start: '10:00', title: 'Loses to one-offs' },
    { recurring: true, weekday: wd, start: '14:10', title: 'Weekly 1:1' },
    { date, start: '15:40', title: 'Too early for 16:00' } ] });
  eq(r.status, 201); eq(r.data.count, 5);
  r = await app('GET', '/api/v1/state');
  const segs = (id) => r.data.events.filter(e => e.id.startsWith('work@x|' + id)).map(e => `${hm(new Date(e.start))}-${hm(new Date(e.end))} ${e.title || 'Busy'}`);
  eq(segs('fb1').join(', '), '10:00-10:30 Team sync, 10:30-11:00 Design review', 'merged block split at label times; early label clipped to block; default ends at next label');
  eq(segs('fb2').join(', '), '14:00-14:10 Busy, 14:10-14:30 Weekly 1:1', 'recurring label at its own time, rest Busy');
  eq(segs('fb3').join(', '), '16:00-17:00 Busy', 'label 20 min early does not match');
  ok(r.data.events.find(e => e.title === 'Team sync').labeled && !r.data.events.find(e => e.id === 'work@x|fb2').labeled, 'labeled flag only on label spans');
  ok(r.data.events.filter(e => !e.busy).every(e => !e.labeled), 'non-busy events untouched');
  // the reported case: holds + meeting merged into one 06:00-11:00 block, meeting labeled 10:30
  const day2 = local(new Date(Date.now() + 2 * 86400000)), date2 = `${day2.year}-${day2.month}-${day2.day}`;
  const at2 = (h, m) => { for (const off of [7, 8]) { const d = new Date(`${date2}T${String(h + off).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); if (hm(d) === `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`) return d; } };
  E.run('fb4', at2(6, 0).toISOString(), at2(11, 0).toISOString(), now, now);
  E.run('fb5', at2(14, 0).toISOString(), at2(17, 0).toISOString(), now, now);
  const P = sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, title, status, first_seen, last_seen) VALUES ('owner', 'primary', ?, ?, ?, 0, ?, 'confirmed', ?, ?)");
  P.run('own1', at2(13, 30).toISOString(), at2(15, 0).toISOString(), 'Own block', now, now);
  r = await agent('POST', '/api/agent/event-labels', { labels: [{ date: date2, start: '10:30', title: 'Roadmap review' }, { date: date2, start: '15:00', end: '16:00', title: 'Planning' }] });
  r = await app('GET', '/api/v1/state');
  eq(segs('fb4').join(', '), '06:00-10:30 Busy, 10:30-11:00 Roadmap review', 'meeting renders at 10:30, not 06:00');
  eq(segs('fb5').join(', '), '15:00-16:00 Planning, 16:00-17:00 Busy', 'label end used; Busy under own event hidden');
  const view = buildEvents(r.data.events, tz)[dnum(date2)].filter(e => e[3] === 'work').map(e => e[2]);
  eq(view.join(','), 'Busy,Roadmap review,Planning,Busy', 'client rows in time order');
  r = await agent('GET', '/api/agent/event-labels'); eq(r.data.count, 7);
  r = await agent('DELETE', '/api/agent/event-labels/' + r.data.labels.find(l => l.title === 'Weekly 1:1').id); eq(r.status, 200);
  r = await app('GET', '/api/v1/state'); eq(segs('fb2').join(', '), '14:00-14:30 Busy', 'unlabeled again (UI shows Busy)');
  for (const bad of [{ title: 'x', start: '9:00', date }, { title: 'x', start: '09:00' }, { title: 'x', start: '09:00', recurring: true, weekday: 7 }, { start: '09:00', date }])
    { r = await agent('POST', '/api/agent/event-labels', bad); eq(r.status, 400, JSON.stringify(bad)); }
  r = await agent('DELETE', '/api/agent/event-labels/el-nope'); eq(r.status, 404); }

// ---- device tokens (Android shell): paired with the cookie, only three routes ----
{ r = await call('POST', '/api/v1/devices', { label: 'Pixel' }); eq(r.status, 401, 'pairing needs the session');
  r = await app('POST', '/api/v1/devices', { label: 'Pixel' }); eq(r.status, 201); ok(/^dv_[0-9a-f]{64}$/.test(r.data.token)); const dev = r.data;
  ok(!JSON.stringify(sqlite.prepare('SELECT * FROM device_tokens').all()).includes(dev.token), 'only the hash is stored');
  const D = (m, p, b) => call(m, p, b, { authorization: 'Bearer ' + dev.token });
  r = await D('GET', '/api/v1/widget/today'); eq(r.status, 200); ok(Array.isArray(r.data.items) && r.data.date, 'widget');
  ok(r.data.items.every(i => !('notes' in i)), 'no notes on the widget');
  { // next_event uses the labeled rows: a busy block starting in 2 min, labeled at its start
    const a = new Date(Math.ceil((Date.now() + 120000) / 60000) * 60000), z = new Date(a.getTime() + 3600000), now = new Date().toISOString();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(a).map(x => [x.type, x.value]));
    sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, all_day, title, status, first_seen, last_seen) VALUES ('owner', 'work@x', 'wg1', ?, ?, 0, NULL, 'busy', ?, ?)").run(a.toISOString(), z.toISOString(), now, now);
    r = await D('GET', '/api/v1/widget/today');
    const plain = r.data.next_event;
    await agent('POST', '/api/agent/event-labels', { date: `${p.year}-${p.month}-${p.day}`, start: `${p.hour}:${p.minute}`, title: 'Widget meeting' });
    r = await D('GET', '/api/v1/widget/today');
    if (plain && plain.start === a.toISOString()) { eq(plain.title, 'Busy', 'unlabeled block is Busy'); eq(r.data.next_event.title, 'Widget meeting', 'widget next_event shows the label'); }
    else if (p.hour !== '23') assert.fail('widget next_event: expected the 2-min block, got ' + JSON.stringify(plain));
    sqlite.prepare("DELETE FROM calendar_events WHERE event_id = 'wg1'").run(); }
  r = await D('POST', '/api/v1/feedback', { note: 'from the phone', screen: 'widget' }); eq(r.status, 201);
  const tv = (await app('POST', '/api/v1/tasks', { title: 'Timer via device', start: 'anytime' })).data.id;
  r = await app('POST', '/api/v1/timer', { action: 'start', task_id: tv }); eq(r.status, 200);
  r = await D('POST', '/api/v1/timer', { action: 'stop' }); eq(r.status, 200); ok(r.data.stopped, 'device stops the timer');
  r = await D('POST', '/api/v1/timer', { action: 'start', task_id: 't-call' }); eq(r.status, 403, 'device cannot start timers');
  // the widget checkbox: complete / undo only; repeats advance like the app; a running timer stops; logged as via 'device'
  const one = (await app('POST', '/api/v1/tasks', { title: 'Widget tick', start: 'anytime' })).data.id;
  r = await app('POST', '/api/v1/timer', { action: 'start', task_id: one }); eq(r.status, 200);
  r = await D('PATCH', '/api/v1/tasks/' + one, { completed: true }); eq([r.status, r.data.completed], [200, true], 'device completes');
  ok(row(one).completed_at && !sqlite.prepare('SELECT * FROM time_entries WHERE task_id = ? AND stopped_at IS NULL').get(one), 'completed, timer stopped');
  ok(sqlite.prepare("SELECT * FROM events WHERE kind = 'task_completed' AND task_id = ?").get(one).props.includes('"via":"device"'), 'logged via device');
  ok(sqlite.prepare("SELECT * FROM events WHERE kind = 'timer_stopped' AND task_id = ? ORDER BY at DESC").get(one).props.includes('"via":"device"'), 'timer stop logged via device');
  r = await D('PATCH', '/api/v1/tasks/' + one, { completed: false }); eq([r.status, r.data.completed, row(one).completed_at], [200, false, null], 'device undoes');
  const rep = (await app('POST', '/api/v1/tasks', { title: 'Widget daily', start: 'date', start_date: '2030-02-10', repeat: { freq: 'daily' } })).data.id;
  r = await D('PATCH', '/api/v1/tasks/' + rep, { completed: true }); eq([r.data.completed, r.data.due_date, r.data.repeating], [false, '2030-02-11', true], 'repeat advances to the next date');
  ok(sqlite.prepare("SELECT COUNT(*) AS n FROM completions WHERE task_id = ?").get(rep).n === 1, 'completion logged for the repeat');
  r = await D('PATCH', '/api/v1/tasks/' + rep, { completed: false }); eq(row(rep).due_date, '2030-02-10', 'undo puts the repeat back');
  for (const bad of [{ title: 'x' }, { completed: true, title: 'x' }, { start_date: '2030-01-01' }, { trashed: true }, { canceled: true }, { completed: 'yes' }])
    { r = await D('PATCH', '/api/v1/tasks/' + one, bad); eq(r.status, 403, 'device cannot send ' + JSON.stringify(bad)); }
  eq(row(one).title, 'Widget tick'); ok(!row(one).trashed_at && !row(one).dropped_at, 'nothing else changed');
  for (const [m, p] of [['DELETE', '/api/v1/tasks/' + one], ['POST', '/api/v1/tasks/' + one], ['PATCH', '/api/v1/projects/p-x'], ['PATCH', '/api/tasks/' + one], ['POST', '/api/tasks/' + one + '/complete']]) { r = await D(m, p, {}); ok(r.status === 403 || r.status === 401 || r.status === 404, `device refused on ${m} ${p} (${r.status})`); }
  r = await D('PATCH', '/api/v1/tasks/t-nope', { completed: true }); eq(r.status, 404);
  // the add-task widget: {title, client_id} only -> an Inbox to-do; a retry with the same client_id returns the same one
  r = await D('POST', '/api/v1/tasks', { title: '  Buy stamps ', client_id: 'c-123' }); eq(r.status, 201); eq(r.data.title, 'Buy stamps');
  const made = row(r.data.id);
  eq(`${made.inbox},${made.due_date},${made.area_id},${made.project_id},${made.created_via},${made.completed_at}`, '1,null,null,null,android,null', 'Inbox, no date or area, created via android');
  r = await D('POST', '/api/v1/tasks', { title: 'Buy stamps', client_id: 'c-123' }); eq(`${r.status},${r.data.id}`, `200,${made.id}`, 'retry returns the same to-do');
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Buy stamps'").get().n, 1, 'no duplicate');
  r = await D('POST', '/api/v1/tasks', { title: 'Buy stamps', client_id: 'c-124' }); eq(r.status, 201, 'new client_id, new to-do');
  r = await app('GET', '/api/v1/state'); ok(r.data.tasks.some(t => t.id === made.id && t.start === 'inbox'), 'shows in the app Inbox');
  ok(sqlite.prepare("SELECT props FROM events WHERE kind = 'task_created' AND task_id = ?").get(made.id).props.includes('"via":"device"'), 'logged via device');
  for (const bad of [{ title: 'x' }, { client_id: 'c' }, { title: 'x', client_id: 'c', start_date: '2030-01-01' }, { title: 'x', client_id: 'c', area_id: 'a' }, { title: 'x', client_id: 'c', notes: 'n' }])
    { r = await D('POST', '/api/v1/tasks', bad); eq(r.status, 403, 'device create refuses ' + JSON.stringify(bad)); }
  for (const bad of [{ title: '', client_id: 'c' }, { title: 'x'.repeat(201), client_id: 'c' }, { title: 'x', client_id: '' }, { title: 'x', client_id: 'c'.repeat(65) }, { title: 3, client_id: 'c' }])
    { r = await D('POST', '/api/v1/tasks', bad); eq(r.status, 400, 'device create 400 ' + JSON.stringify(bad).slice(0, 40)); }
  r = await app('POST', '/api/v1/tasks', { title: 'Cookie create', start: 'anytime' }); eq(r.status, 201, 'cookie create unchanged');
  r = await app('PATCH', '/api/v1/tasks/' + one, { title: 'Widget tick 2', completed: true }); eq([r.status, row(one).title, !!row(one).completed_at], [200, 'Widget tick 2', true], 'cookie PATCH unchanged');
  r = await agent('PATCH', '/api/agent/tasks/' + one, { title: 'Widget tick 3' }); eq([r.status, row(one).title], [200, 'Widget tick 3'], 'agent auth unchanged');
  for (const [m, p] of [['GET', '/api/v1/state'], ['POST', '/api/v1/tasks'], ['GET', '/api/v1/devices'], ['GET', '/api/tasks']]) { r = await D(m, p, m === 'GET' ? undefined : {}); ok(r.status === 403 || r.status === 401, `device token refused on ${m} ${p}`); }
  r = await call('GET', '/api/agent/snapshot', undefined, { authorization: 'Bearer ' + dev.token }); eq(r.status, 401, 'not an agent key');
  r = await call('GET', '/api/v1/widget/today', undefined, { authorization: 'Bearer dv_' + '0'.repeat(64) }); eq(r.status, 401, 'unknown token');
  r = await app('GET', '/api/v1/devices'); eq(r.data.devices.map(x => x.label), ['Pixel']); ok(r.data.devices[0].last_used_at, 'last used tracked');
  r = await app('DELETE', '/api/v1/devices/' + dev.id); eq(r.status, 200);
  r = await D('GET', '/api/v1/widget/today'); eq(r.status, 401, 'revoked');
  r = await app('GET', '/api/v1/devices'); eq(r.data.devices.length, 0);
  eq(evN('device_paired'), 1); }

console.log(`test-v1-api: ${checks} checks passed`);
