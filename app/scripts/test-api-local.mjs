// Local API test for task signals (B28/B29/B30/B4): runs the real Worker against an in-memory
// SQLite shim of D1 (node:sqlite, Node >= 22.5). No wrangler, no network, no real data.
// Run: node scripts/test-api-local.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

// Build the DB the way prod got it: schema before 0005, then the 0005 migration
const schema = fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8');
const before = schema.replace(/^\s*ask_outcome .*\n/m, '').replace(/^\s*dropped_at .*\n/m, '')
  .replace(/^\s*removed_at .*\n/m, '').replace(/^\s*prev .*\n/m, '')
  .replace(/^\s*retired_at .*\n/m, '').replace(/^\s*inbox INTEGER .*\n/m, '')
  .replace(/^  start TEXT,\n[\s\S]*?^  created_via TEXT,\n/m, '').replace(/-- my-os v1 model[\s\S]*$/, '');
assert.ok(!before.includes('ask_outcome') && !before.includes('dropped_at'));
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(before);
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0005_status_signals.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0006_item_changes.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0009_source_retired.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0010_weekly_theme.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0011_task_inbox.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0012_v1_model.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0013_settings.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0014_event_labels.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0015_item_attachments.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0016_attachment_descriptions.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0017_attachment_note.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0018_attachment_files.sql'), 'utf-8'));
// The full schema.sql must also load on its own (fresh installs)
new DatabaseSync(':memory:').exec(schema);

// Minimal D1 shim
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
const DB = { prepare: (sql) => new Stmt(sql), batch: async (stmts) => { const out = []; for (const s of stmts) out.push(await s.run()); return out; } };
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const env = { DB, APP_PASSPHRASE: 'dev', AGENT_KEY: 'test-agent-key', INGEST_KEY: 'test-ingest-key', ASSETS: { fetch: async () => new Response('asset') } };

const worker = (await import('../src/index.js')).default;
const BASE = 'https://example.test';
const flush = async () => { while (pending.length) await pending.shift(); };

// Login for the cookie
const form = new FormData(); form.set('passphrase', 'dev');
const login = await worker.fetch(new Request(BASE + '/login', { method: 'POST', body: form }), env, ctx);
assert.equal(login.status, 302);
const cookie = login.headers.get('set-cookie').split(';')[0];

async function app(method, p, body) {
  const res = await worker.fetch(new Request(BASE + p, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await flush();
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}
async function agent(method, p, body) {
  const res = await worker.fetch(new Request(BASE + p, { method, headers: { authorization: 'Bearer test-agent-key', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  await flush();
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch (e) { data = text; }
  return { status: res.status, data };
}
const row = (id) => sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const lastEvent = (id, kind) => {
  const e = sqlite.prepare('SELECT * FROM events WHERE task_id = ? AND kind = ? ORDER BY at DESC LIMIT 1').get(id, kind);
  return e ? { ...e, props: JSON.parse(e.props || '{}') } : null;
};
const lastLine = (notes) => String(notes || '').split('\n').pop();

let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

// --- Existing behaviour still works ---
let r = await app('GET', '/api/tasks');
eq(r.status, 200); eq(r.data.tasks, []); eq(r.data.completed_today, []); eq(r.data.dropped, []);
const today = r.data.today;

// --- B28: snooze reason ---
r = await app('POST', '/api/tasks', { title: 'Test one-off', due_date: today, list: 'Tasks' });
eq(r.status, 201);
const a = r.data.id;
eq(r.data.ask_outcome, 0); eq(r.data.dropped_at, null);
r = await app('POST', `/api/tasks/${a}/snooze`, { to: 'tomorrow' });
eq(r.data.previous.due_date, today);
r = await app('POST', `/api/tasks/${a}/signal`, { kind: 'later', reason: 'waiting', text: 'no reply\nyet' });
eq(r.status, 200);
const tomorrow = row(a).due_date;
ok(/^\d{4}-\d{2}-\d{2} snoozed → \w{3} \d{1,2}: Waiting on someone \(no reply yet\)$/.test(row(a).notes), row(a).notes);
eq(lastEvent(a, 'task_snoozed').props.reason, 'waiting');
eq(lastEvent(a, 'task_snoozed').props.text, 'no reply yet');
eq(lastEvent(a, 'task_snoozed').props.to, tomorrow); // original payload kept
r = await app('POST', `/api/tasks/${a}/signal`, { kind: 'later' });
eq(r.status, 400, 'empty signal rejected');
r = await app('POST', `/api/tasks/${a}/signal`, { kind: 'later', reason: 'bogus' });
eq(r.status, 400);

// Edit to a later date -> "moved"
const later = sqlite.prepare("SELECT date(?, '+5 day') AS d").get(today).d;
r = await app('PATCH', `/api/tasks/${a}`, { due_date: later });
eq(r.status, 200);
r = await app('POST', `/api/tasks/${a}/signal`, { kind: 'later', reason: 'No time' });
ok(lastLine(row(a).notes).includes(' moved → ') && lastLine(row(a).notes).endsWith(': No time'), row(a).notes);
eq(row(a).notes.split('\n').length, 2, 'appended, not overwritten');
eq(lastEvent(a, 'task_edited').props.reason, 'no_time');

// --- B29: ask_outcome + outcome ---
r = await agent('POST', '/api/agent/tasks', { title: 'Test call', ask_outcome: true, notes: 'existing note' });
eq(r.status, 201); eq(r.data.ask_outcome, 1);
const b = r.data.id;
r = await agent('POST', '/api/agent/tasks', { title: 'Bad', ask_outcome: 'yes' });
eq(r.status, 400);
r = await agent('PATCH', `/api/agent/tasks/${a}`, { ask_outcome: true });
eq(r.data.ask_outcome, 1);
r = await app('PATCH', `/api/tasks/${a}`, { ask_outcome: false });
eq(r.data.ask_outcome, 0);
r = await app('POST', `/api/tasks/${b}/complete`);
r = await app('POST', `/api/tasks/${b}/signal`, { kind: 'outcome', text: 'They said yes.' });
eq(r.status, 200);
eq(row(b).notes, `existing note\n${today} done: They said yes.`);
eq(lastEvent(b, 'task_completed').props.outcome, 'They said yes.');
r = await app('GET', '/api/tasks');
ok(r.data.completed_today.some(c => c.task_id === b && c.can_undo && !c.recurring), 'B4 one-off listed');

// --- B4: recurring, only latest completion undoable ---
r = await app('POST', '/api/tasks', { title: 'Test daily', due_date: sqlite.prepare("SELECT date(?, '-2 day') AS d").get(today).d, recurrence: 'daily', list: 'Tasks' });
const c = r.data.id;
await app('POST', `/api/tasks/${c}/complete`);
await new Promise(res => setTimeout(res, 5));
await app('POST', `/api/tasks/${c}/complete`);
r = await app('GET', '/api/tasks');
const cs = r.data.completed_today.filter(x => x.task_id === c);
eq(cs.length, 2); eq(cs.map(x => x.can_undo), [true, false]);
await app('POST', `/api/tasks/${c}/uncomplete`);
r = await app('GET', '/api/tasks');
eq(r.data.completed_today.filter(x => x.task_id === c).length, 1);

// --- B30: one-off won't do + restore ---
r = await app('POST', '/api/tasks', { title: 'Test drop', due_date: today, list: 'Tasks' });
const d = r.data.id;
r = await app('POST', `/api/tasks/${d}/drop`, { reason: 'not_worth_it', text: 'meh' });
eq(r.status, 200); ok(r.data.task.dropped_at);
eq(lastLine(row(d).notes), `${today} won't do: Not worth it (meh)`);
eq(lastEvent(d, 'task_dropped').props.reason, 'not_worth_it');
r = await app('GET', '/api/tasks');
ok(!r.data.tasks.some(t => t.id === d), 'hidden from active');
ok(r.data.dropped.some(t => t.id === d), 'in Won\'t do list');
r = await app('POST', `/api/tasks/${d}/drop`, {});
eq(r.status, 409);
r = await app('POST', `/api/tasks/${d}/restore`, {});
eq(r.status, 200); eq(row(d).dropped_at, null);
eq(lastLine(row(d).notes), `${today} restored`);
r = await app('POST', `/api/tasks/${d}/restore`, {});
eq(r.status, 409);
// No reason = no notes line
r = await app('POST', `/api/tasks/${d}/drop`, {});
eq(r.status, 200); eq(lastLine(row(d).notes), `${today} restored`);
await app('POST', `/api/tasks/${d}/restore`, {});
eq(lastLine(row(d).notes), `${today} restored`, 'no duplicate restored line');

// --- B30: recurring skip / stop ---
r = await app('POST', '/api/tasks', { title: 'Test weekly', due_date: today, recurrence: 'weekly', list: 'Tasks' });
const w = r.data.id;
r = await app('POST', `/api/tasks/${w}/drop`, { reason: 'duplicate' });
eq(r.status, 400, 'series required');
r = await app('POST', `/api/tasks/${w}/drop`, { series: 'skip', reason: 'overtaken' });
eq(r.status, 200); eq(r.data.skipped, true); eq(r.data.previous.due_date, today);
eq(row(w).due_date, sqlite.prepare("SELECT date(?, '+7 day') AS d").get(today).d); eq(row(w).dropped_at, null);
ok(lastLine(row(w).notes).startsWith(`${today} won't do (skipped `), row(w).notes);
r = await app('POST', `/api/tasks/${w}/restore`, { due_date: today, snoozed_from: null });
eq(r.status, 200); eq(row(w).due_date, today); eq(lastLine(row(w).notes), `${today} restored`);
r = await app('POST', `/api/tasks/${w}/drop`, { series: 'stop', reason: 'changed_mind' });
ok(row(w).dropped_at); ok(lastLine(row(w).notes).includes("won't do (stopped series): Changed my mind"));

// --- Agent API: dropped / restore / status / snapshot ---
r = await agent('POST', '/api/agent/tasks', { title: 'Test agent drop' });
const e = r.data.id;
r = await agent('PATCH', `/api/agent/tasks/${e}`, { dropped: true, reason: 'Someone else did it' });
eq(r.status, 200); ok(r.data.dropped_at);
eq(lastEvent(e, 'task_dropped').props.via, 'agent');
r = await agent('PATCH', `/api/agent/tasks/${e}`, { reason: 'duplicate' });
eq(r.status, 400, 'reason without dropped');
r = await agent('PATCH', `/api/agent/tasks/${e}`, { dropped: true, completed: true });
eq(r.status, 400);
r = await agent('PATCH', `/api/agent/tasks/${e}`, { dropped: 'yes' });
eq(r.status, 400);
r = await agent('GET', '/api/agent/tasks?status=open');
ok(!r.data.tasks.some(t => t.id === e));
r = await agent('GET', '/api/agent/tasks?status=all');
ok(r.data.tasks.find(t => t.id === e).dropped_at);
r = await agent('GET', '/api/agent/tasks?status=dropped');
ok(r.data.tasks.every(t => t.dropped_at));
r = await agent('GET', '/api/agent/snapshot');
ok(r.data.includes("## Won't do (last 24h)"), 'snapshot section');
ok(r.data.includes('Test agent drop') && r.data.includes('Someone else did it'), r.data);
ok(r.data.includes('skipped one occurrence'), 'skip in snapshot');
r = await agent('PATCH', `/api/agent/tasks/${e}`, { dropped: false });
eq(r.status, 200); eq(r.data.dropped_at, null);
r = await agent('PATCH', `/api/agent/tasks/${e}`, { title: 'Test agent drop 2', dropped: true, reason: 'duplicate' });
eq(r.data.title, 'Test agent drop 2'); ok(r.data.dropped_at);
// Old agent calls unchanged
r = await agent('PATCH', `/api/agent/tasks/${a}`, {});
eq(r.status, 400);
r = await agent('PATCH', `/api/agent/tasks/${a}`, { completed: true });
eq(r.status, 200); ok(r.data.completed_at);
r = await agent('PATCH', '/api/agent/tasks/t-nope', { dropped: true });
eq(r.status, 404);
// B34: AI cleanup may return P3; quick-add area is accepted (AI cleanup is now opt-in: QUICKADD_AI=1)
env.QUICKADD_AI = '1';
env.AI = { run: async () => ({ response: { title: 'Someday tidy the garage shelves', due_date: null, priority: 'P3', recurrence: null } }) };
r = await app('POST', '/api/tasks', { title: 'someday tidy garage', raw: 'someday maybe tidy up the garage shelves when there is time', area: 'work' });
eq(r.status, 201);
ok(r.data.ai_cleaned, 'ai cleaned');
eq(row(r.data.id).priority, 'P3');
eq(row(r.data.id).area, 'work');
env.AI = { run: async () => ({ response: { title: 'Bad priority', due_date: null, priority: 'P9', recurrence: null } }) };
r = await app('POST', '/api/tasks', { title: 'bad prio', raw: 'this one has a long raw text so the ai cleanup step runs here' });
eq(row(r.data.id).priority, 'P2', 'invalid AI priority falls back to default');
eq(row(r.data.id).area, null);
delete env.AI;
delete env.QUICKADD_AI;
// Quick-add hotfix: AI off by default -> title kept as typed, no guessed date/priority, no "Captured:" notes
{
  let aiCalls = 0;
  env.AI = { run: async () => { aiCalls++; return { response: { title: 'Rewritten', due_date: '2030-01-01', priority: 'P0', recurrence: null } }; } };
  const raw = 'call the plumber about the leak under the kitchen sink soon please';
  r = await app('POST', '/api/tasks', { title: raw, raw, explicit: {} });
  eq(r.status, 201); eq(aiCalls, 0, 'AI not called'); eq(r.data.ai_cleaned, false);
  eq(row(r.data.id).title, raw); eq(row(r.data.id).priority, 'P2'); eq(row(r.data.id).notes, null);
  delete env.AI;
}
// B35: calendar snapshot diff on ingest
{
  const W = { source: 'gcal', window_start: '2026-10-10T00:00:00Z', window_end: '2026-10-17T00:00:00Z' };
  const ev = (id, ts, title, snippet) => ({ ext_id: id, ts, title, ...(snippet ? { snippet } : {}) });
  const evCount = () => sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'calendar_diff'").get().n;
  const ev0 = evCount();
  // Without a snapshot: unchanged response shape
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', items: [ev('c-1', '2026-10-11T17:00:00Z', 'Dentist')] });
  eq(r.status, 200); eq(r.data.inserted, 1); ok(!('added' in r.data) && !('removed' in r.data), JSON.stringify(r.data));
  eq(evCount(), ev0, 'no diff event without snapshot');
  // First complete snapshot: c-1 already known, c-2 + c-3 added
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [
    ev('c-1', '2026-10-11T17:00:00Z', 'Dentist'), ev('c-2', '2026-10-12T09:00:00Z', 'Standup', 'Room 4'), ev('c-3', '2026-10-13T12:00:00Z', 'Lunch')] });
  eq(r.status, 200);
  eq(JSON.stringify(r.data.added), JSON.stringify(['c-2', 'c-3']));
  eq(r.data.changed.length, 0); eq(r.data.removed.length, 0);
  // Next snapshot: c-1 moved, c-2 renamed, c-3 gone, c-4 new; c-old outside the window is untouched
  await agent('POST', '/api/agent/ingest', { source: 'gcal', items: [ev('c-old', '2026-10-01T10:00:00Z', 'Old')] });
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [
    ev('c-1', '2026-10-11T18:00:00Z', 'Dentist'), ev('c-2', '2026-10-12T09:00:00Z', 'Team standup'), ev('c-4', '2026-10-14T08:00:00Z', 'Flight')] });
  eq(JSON.stringify(r.data.added), JSON.stringify(['c-4']));
  eq(r.data.changed.length, 2);
  const c1 = r.data.changed.find(c => c.ext_id === 'c-1');
  eq(c1.before.ts, '2026-10-11T17:00:00.000Z'); eq(c1.after.ts, '2026-10-11T18:00:00.000Z');
  const c2 = r.data.changed.find(c => c.ext_id === 'c-2');
  eq(c2.before.title, 'Standup'); eq(c2.after.title, 'Team standup'); eq(c2.after.snippet, 'Room 4', 'omitted snippet is kept, not a change');
  eq(JSON.stringify(r.data.removed), JSON.stringify(['c-3']));
  const irow = (id) => sqlite.prepare("SELECT * FROM items WHERE source = 'gcal' AND ext_id = ?").get(id);
  ok(irow('c-3') && irow('c-3').removed_at, 'removed row kept with removed_at');
  eq(JSON.parse(irow('c-1').prev).ts, '2026-10-11T17:00:00.000Z');
  eq(irow('c-old').removed_at, null, 'outside window untouched');
  ok(evCount() === ev0 + 2, 'calendar_diff emitted per snapshot');
  const evRow = sqlite.prepare("SELECT props FROM events WHERE kind = 'calendar_diff' ORDER BY at DESC, rowid DESC LIMIT 1").get();
  const evp = JSON.parse(evRow.props); eq(evp.added, 1); eq(evp.changed, 2); eq(evp.removed, 1);
  // Items list hides removed by default; include_removed=1 shows it with prev parsed
  r = await agent('GET', '/api/agent/items?source=gcal&since=2026-09-01T00:00:00Z');
  ok(!r.data.items.some(i => i.ext_id === 'c-3'), 'removed hidden');
  r = await agent('GET', '/api/agent/items?source=gcal&since=2026-09-01T00:00:00Z&include_removed=1');
  ok(r.data.items.some(i => i.ext_id === 'c-3'), 'removed shown on request');
  eq(r.data.items.find(i => i.ext_id === 'c-1').prev.ts, '2026-10-11T17:00:00.000Z');
  // Same snapshot again: nothing changes
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [
    ev('c-1', '2026-10-11T18:00:00Z', 'Dentist'), ev('c-2', '2026-10-12T09:00:00Z', 'Team standup'), ev('c-4', '2026-10-14T08:00:00Z', 'Flight')] });
  eq(r.data.added.length + r.data.changed.length + r.data.removed.length, 0, JSON.stringify(r.data));
  // Empty batch without complete:true must not remove anything
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W }, items: [] });
  eq(r.status, 200); eq(r.data.removed.length, 0); ok(r.data.removals_skipped, 'skip reason');
  eq(irow('c-1').removed_at, null);
  // A rejected item blocks removals too
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [ev('c-1', 'not a date', 'x')] });
  eq(r.data.removed.length, 0); ok(r.data.removals_skipped && r.data.rejected.length === 1);
  // A removed event that comes back counts as added and is un-removed
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [
    ev('c-1', '2026-10-11T18:00:00Z', 'Dentist'), ev('c-2', '2026-10-12T09:00:00Z', 'Team standup'), ev('c-3', '2026-10-13T12:00:00Z', 'Lunch'), ev('c-4', '2026-10-14T08:00:00Z', 'Flight')] });
  eq(JSON.stringify(r.data.added), JSON.stringify(['c-3'])); eq(irow('c-3').removed_at, null);
  // Complete empty snapshot removes everything in the window (explicitly complete)
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: true }, items: [] });
  eq(r.data.removed.length, 4);
  // Validation
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, source: 'other' }, items: [] }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, window_end: 'nope' }, items: [] }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, window_end: W.window_start }, items: [] }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: { ...W, complete: 'yes' }, items: [] }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/ingest', { source: 'gcal', snapshot: 'x', items: [] }); eq(r.status, 400);
}
// Scoped ingest key: only POST ingest + health
{
  const ik = async (method, p, body) => {
    const res = await worker.fetch(new Request(BASE + p, { method, headers: { authorization: 'Bearer test-ingest-key', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    await flush();
    return res.status;
  };
  eq(await ik('POST', '/api/agent/ingest', { source: 'chatnet', items: [{ ext_id: 'k1', ts: '2026-10-09T10:00:00Z', snippet: 'hi' }] }), 200);
  eq(await ik('POST', '/api/agent/health', { source: 'chatnet', ok: true }), 200);
  for (const [m, p, b] of [['GET', '/api/agent/health'], ['GET', '/api/agent/items'], ['GET', '/api/agent/tasks'], ['POST', '/api/agent/tasks', { title: 'x' }],
    ['PATCH', '/api/agent/tasks/t-x', { completed: true }], ['POST', '/api/agent/brief', { date: '2026-10-09', body_md: 'x' }], ['GET', '/api/agent/snapshot'],
    ['POST', '/api/agent/calendar/sync'], ['POST', '/api/agent/mail/sync'], ['GET', '/api/agent/mail/messages'], ['GET', '/api/agent/version'], ['GET', '/api/agent/ingest']]) {
    eq(await ik(m, p, b), 403, `${m} ${p} forbidden for the ingest key`);
  }
  // Not a session cookie either
  const res = await worker.fetch(new Request(BASE + '/api/tasks', { headers: { authorization: 'Bearer test-ingest-key' } }), env, ctx);
  eq(res.status, 401);
  // Wrong key, and the full key still works everywhere
  const bad = await worker.fetch(new Request(BASE + '/api/agent/ingest', { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' }), env, ctx);
  eq(bad.status, 401);
  r = await agent('GET', '/api/agent/health'); eq(r.status, 200);
  // Without INGEST_KEY set, the ingest key is just unknown
  const noKey = await worker.fetch(new Request(BASE + '/api/agent/ingest', { method: 'POST', headers: { authorization: 'Bearer test-ingest-key' }, body: '{}' }), { ...env, INGEST_KEY: undefined }, ctx);
  eq(noKey.status, 401);
}
// B40: retired sources
{
  const now = new Date().toISOString();
  for (const src of ['calendar', 'messages', 'gcal_sync']) sqlite.prepare("INSERT OR IGNORE INTO source_health (tenant_id, source, last_ok, last_attempt) VALUES ('owner', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')").run(src);
  // The migration retires the legacy names; rerunning its UPDATE here applies it to the rows just inserted
  sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0009_source_retired.sql'), 'utf-8').split('\n').filter(l => !l.startsWith('ALTER')).join('\n'));
  ok(sqlite.prepare("SELECT retired_at FROM source_health WHERE source = 'calendar'").get().retired_at, 'legacy retired');
  eq(sqlite.prepare("SELECT retired_at FROM source_health WHERE source = 'gcal_sync'").get().retired_at, null);
  r = await agent('GET', '/api/agent/health');
  ok(!r.data.sources.some(x => x.source === 'calendar' || x.source === 'messages'), 'hidden from health');
  ok(r.data.sources.some(x => x.source === 'gcal_sync'));
  r = await agent('GET', '/api/agent/health?include_retired=1');
  const cal = r.data.sources.find(x => x.source === 'calendar');
  ok(cal && cal.retired_at && cal.stale === false, 'retired rows are never stale');
  r = await agent('GET', '/api/agent/snapshot');
  ok(!/^- calendar:/m.test(r.data) && !/^- messages:/m.test(r.data), 'hidden from snapshot freshness'); ok(/^- gcal_sync:/m.test(r.data));
  // A retired source that posts health stays retired
  r = await agent('POST', '/api/agent/health', { source: 'calendar', ok: true }); eq(r.status, 200);
  ok(sqlite.prepare("SELECT retired_at FROM source_health WHERE source = 'calendar'").get().retired_at);
  // Restore and retire through the API
  r = await agent('POST', '/api/agent/health/retire', { source: 'calendar', retired: false });
  eq(r.status, 200); eq(r.data.retired_at, undefined);
  r = await agent('GET', '/api/agent/health'); ok(r.data.sources.some(x => x.source === 'calendar'), 'restored');
  r = await agent('POST', '/api/agent/health/retire', { source: 'calendar', retired: true }); ok(r.data.retired_at);
  r = await agent('POST', '/api/agent/health/retire', { source: 'nope', retired: true }); eq(r.status, 404);
  r = await agent('POST', '/api/agent/health/retire', { source: 'calendar' }); eq(r.status, 400);
  const ikr = await worker.fetch(new Request(BASE + '/api/agent/health/retire', { method: 'POST', headers: { authorization: 'Bearer test-ingest-key' }, body: JSON.stringify({ source: 'calendar', retired: false }) }), env, ctx);
  eq(ikr.status, 403, 'ingest key cannot retire'); void now;
}
// B42: weekly theme
{
  const laToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const d = new Date(laToday + 'T00:00:00Z');
  const monday = new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
  r = await agent('GET', '/api/agent/theme');
  eq(r.status, 200); eq(r.data.week_start, monday); eq(r.data.theme, null);
  r = await app('GET', '/api/brief'); eq(r.data.theme, null, 'no theme in the brief yet');
  r = await agent('PUT', '/api/agent/theme', { week_start: monday, work_title: 'Ship it', work_line: 'Finish the launch', personal_title: 'Rest', personal_line: 'Early nights', through_line: 'Less, but better' });
  eq(r.status, 200); eq(r.data.theme.work_title, 'Ship it'); eq(r.data.theme.through_line, 'Less, but better'); ok(r.data.theme.updated_at);
  r = await agent('GET', '/api/agent/theme'); eq(r.data.theme.personal_line, 'Early nights');
  r = await app('GET', '/api/brief'); eq(r.data.theme.work_title, 'Ship it', 'theme in the brief');
  // PUT replaces the week (omitted fields become null)
  r = await agent('PUT', '/api/agent/theme', { week_start: monday, work_title: 'Ship it 2' });
  eq(r.data.theme.work_title, 'Ship it 2'); eq(r.data.theme.personal_title, null);
  // Other weeks are separate; validation
  const next = new Date(Date.parse(monday + 'T00:00:00Z') + 7 * 86400000).toISOString().slice(0, 10);
  r = await agent('PUT', '/api/agent/theme', { week_start: next, through_line: 'Next week' }); eq(r.status, 200);
  r = await agent('GET', '/api/agent/theme?week_start=' + next); eq(r.data.theme.through_line, 'Next week');
  r = await agent('GET', '/api/agent/theme'); eq(r.data.theme.work_title, 'Ship it 2', 'current week unchanged');
  const tuesday = new Date(Date.parse(monday + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  r = await agent('PUT', '/api/agent/theme', { week_start: tuesday, work_title: 'x' }); eq(r.status, 400);
  r = await agent('PUT', '/api/agent/theme', { week_start: monday }); eq(r.status, 400, 'needs a field');
  r = await agent('PUT', '/api/agent/theme', { week_start: monday, work_title: 'x'.repeat(121) }); eq(r.status, 400);
  r = await agent('PUT', '/api/agent/theme', { week_start: monday, work_line: 5 }); eq(r.status, 400);
  r = await agent('GET', '/api/agent/theme?week_start=2026-13-01'); eq(r.status, 400);
  const ik = await worker.fetch(new Request(BASE + '/api/agent/theme', { method: 'PUT', headers: { authorization: 'Bearer test-ingest-key', 'content-type': 'application/json' }, body: JSON.stringify({ week_start: monday, work_title: 'x' }) }), env, ctx);
  eq(ik.status, 403, 'ingest key cannot set the theme');
  const ikg = await worker.fetch(new Request(BASE + '/api/agent/theme', { headers: { authorization: 'Bearer test-ingest-key' } }), env, ctx);
  eq(ikg.status, 403);
  ok(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'theme_set'").get().n >= 3, 'theme_set events');
}
// B43: backlog (no due date)
{
  const evN = (k) => sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(k).n;
  const b0 = evN('task_backlogged'), s0 = evN('task_scheduled');
  r = await agent('POST', '/api/agent/tasks', { title: 'Backlog via agent', backlog: true, area: 'house' });
  eq(r.status, 201); eq(r.data.due_date, null);
  const bid = r.data.id;
  r = await agent('POST', '/api/agent/tasks', { title: 'x', backlog: true, due_date: '2026-10-20' }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/tasks', { title: 'x', backlog: true, recurrence: 'daily' }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/tasks', { title: 'x', backlog: 'yes' }); eq(r.status, 400);
  r = await agent('POST', '/api/agent/tasks', { title: 'Dated via agent' });
  const did = r.data.id; ok(r.data.due_date, 'still defaults to today');
  // App quick-add with backlog
  r = await app('POST', '/api/tasks', { title: 'Learn piano', backlog: true, explicit: {} });
  eq(r.status, 201); eq(row(r.data.id).due_date, null, 'app backlog create');
  const qid = r.data.id;
  // List + snapshot
  r = await agent('GET', '/api/agent/tasks?status=backlog');
  ok(r.data.tasks.some(t => t.id === bid) && r.data.tasks.some(t => t.id === qid) && r.data.tasks.every(t => t.due_date === null), 'backlog list');
  ok(!r.data.tasks.some(t => t.id === did));
  r = await agent('GET', '/api/agent/tasks?status=nope'); eq(r.status, 400);
  r = await agent('GET', '/api/agent/snapshot');
  ok(/^## Backlog \(\d+\)$/m.test(r.data) && !r.data.includes('Backlog via agent'), 'count only in snapshot');
  // Move a dated task to the backlog (agent), then schedule it (app)
  r = await agent('PATCH', `/api/agent/tasks/${did}`, { backlog: true });
  eq(r.status, 200); eq(r.data.due_date, null);
  r = await app('PATCH', `/api/tasks/${did}`, { due_date: '2026-11-02' });
  eq(r.status, 200); eq(r.data.due_date, '2026-11-02');
  r = await agent('PATCH', `/api/agent/tasks/${did}`, { backlog: true, due_date: '2026-11-03' }); eq(r.status, 400);
  r = await agent('PATCH', `/api/agent/tasks/${did}`, { backlog: false }); eq(r.status, 400);
  ok(evN('task_backlogged') >= b0 + 3, 'task_backlogged events'); ok(evN('task_scheduled') >= s0 + 1, 'task_scheduled event');
  // Recurring tasks can't go to the backlog
  r = await agent('POST', '/api/agent/tasks', { title: 'Daily thing b43', recurrence: 'daily' });
  const rid = r.data.id;
  r = await agent('PATCH', `/api/agent/tasks/${rid}`, { backlog: true }); eq(r.status, 400);
  r = await agent('PATCH', `/api/agent/tasks/${rid}`, { backlog: true, recurrence: null }); eq(r.status, 200, 'unless the repeat is removed');
  // Existing undated tasks are backlog too (additive)
  sqlite.prepare("INSERT INTO tasks (id, tenant_id, list, title, due_date, created_at, updated_at) VALUES ('t-legacy-undated', 'owner', 'Tasks', 'Old undated', NULL, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  r = await agent('GET', '/api/agent/tasks?status=backlog'); ok(r.data.tasks.some(t => t.id === 't-legacy-undated'));
}
// Quick-add Inbox
{
  const evN = (k) => sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(k).n;
  const triaged = () => sqlite.prepare("SELECT props FROM events WHERE kind = 'inbox_triaged' ORDER BY rowid").all().map(x => JSON.parse(x.props).to);
  const q0 = evN('quickadd_inbox');
  // No date typed -> Inbox (no default to today)
  r = await app('POST', '/api/tasks', { title: 'Inbox one', explicit: {} });
  eq(r.status, 201); eq(r.data.due_date, null); eq(r.data.inbox, 1);
  const i1 = r.data.id;
  eq(evN('quickadd_inbox'), q0 + 1);
  // Explicit date, a repeat, or backlog -> not Inbox
  r = await app('POST', '/api/tasks', { title: 'Dated', due_date: '2026-11-01', explicit: { due_date: true } }); eq(r.data.inbox, 0); eq(r.data.due_date, '2026-11-01');
  r = await app('POST', '/api/tasks', { title: 'Daily', recurrence: 'daily', explicit: { recurrence: true } }); eq(r.data.inbox, 0); ok(r.data.due_date, 'repeat starts today');
  r = await app('POST', '/api/tasks', { title: 'Someday', backlog: true, explicit: {} }); eq(r.data.inbox, 0); eq(r.data.due_date, null);
  // Agent-created tasks never go to the Inbox
  r = await agent('POST', '/api/agent/tasks', { title: 'Agent undated' }); eq(r.data.inbox, 0); ok(r.data.due_date);
  // Views
  r = await agent('GET', '/api/agent/tasks?status=inbox');
  ok(r.data.tasks.some(t => t.id === i1) && r.data.tasks.every(t => t.inbox === 1 && t.due_date === null));
  r = await agent('GET', '/api/agent/tasks?status=backlog');
  ok(!r.data.tasks.some(t => t.id === i1) && r.data.tasks.some(t => t.title === 'Someday'), 'backlog excludes Inbox');
  r = await agent('GET', '/api/agent/snapshot');
  ok(/^## Inbox \(\d+\)$/m.test(r.data) && /^## Backlog \(\d+\)$/m.test(r.data), 'snapshot counts');
  // Triage: date
  r = await app('PATCH', `/api/tasks/${i1}`, { due_date: '2026-10-20' }); eq(r.data.inbox, 0); eq(r.data.due_date, '2026-10-20');
  eq(triaged().at(-1), 'date');
  // Triage: backlog (task stays undated, leaves the Inbox)
  r = await app('POST', '/api/tasks', { title: 'Inbox two', explicit: {} }); const i2 = r.data.id;
  r = await app('PATCH', `/api/tasks/${i2}`, { backlog: true }); eq(r.data.inbox, 0); eq(r.data.due_date, null);
  eq(triaged().at(-1), 'backlog');
  r = await agent('GET', '/api/agent/tasks?status=backlog'); ok(r.data.tasks.some(t => t.id === i2));
  // Other edits keep it in the Inbox
  r = await app('POST', '/api/tasks', { title: 'Inbox three', explicit: {} }); const i3 = r.data.id;
  r = await app('PATCH', `/api/tasks/${i3}`, { title: 'Inbox three edited', priority: 'P1' }); eq(r.data.inbox, 1);
  // Triage: done / dropped
  r = await app('POST', `/api/tasks/${i3}/complete`); eq(r.status, 200); eq(triaged().at(-1), 'done');
  r = await app('POST', '/api/tasks', { title: 'Inbox four', explicit: {} }); const i4 = r.data.id;
  r = await app('POST', `/api/tasks/${i4}/drop`, { reason: 'not_worth_it' }); eq(r.status, 200); eq(triaged().at(-1), 'dropped');
}
r = await app('GET', '/api/stats?days=7');
eq(r.status, 200);

console.log(`test-api-local: ${checks} checks passed`);
