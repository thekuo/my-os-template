// B37 P1: calendar collector against a fake Google Calendar API (mocked fetch) and an in-memory
// SQLite shim of D1 (node:sqlite, Node >= 22.5). No network, no real data.
// Run: node scripts/test-calendar-sync.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const sqlite = new DatabaseSync(':memory:');
sqlite.exec(fs.readFileSync(path.join(root, 'schema.sql'), 'utf-8'));
sqlite.exec(fs.readFileSync(path.join(root, 'migrations/0007_calendar_sync.sql'), 'utf-8')); // idempotent on top

// Minimal D1 shim; batch is atomic like D1
class Stmt {
  constructor(sql, args = []) { this.sql = sql; this.args = args; }
  bind(...a) { return new Stmt(this.sql, a); }
  async all() { return { results: sqlite.prepare(this.sql).all(...this.args) }; }
  async first() { return sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async run() { const r = sqlite.prepare(this.sql).run(...this.args); return { meta: { changes: Number(r.changes) } }; }
}
let failBatch = false;
const DB = {
  prepare: (sql) => new Stmt(sql),
  batch: async (stmts) => {
    if (failBatch) throw new Error('D1 batch failed');
    sqlite.exec('BEGIN');
    try { const out = []; for (const s of stmts) out.push(await s.run()); sqlite.exec('COMMIT'); return out; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
};
const pending = [];
const ctx = { waitUntil: (p) => pending.push(p) };
const flush = async () => { while (pending.length) await pending.shift(); };

// Fake Google: per calendar, events with a change sequence; sync token = seq at issue time
const H = 3600000, DAY = 24 * H, NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const google = { cals: {}, tokenCalls: 0, listCalls: 0, failToken: null, pageSize: 2, busy: {}, fbFail: false, fbWindows: [] };
function cal(id) { return (google.cals[id] ||= { seq: 0, validFrom: 0, events: new Map() }); }
function put(calId, ev) { const c = cal(calId); c.seq++; c.events.set(ev.id, { ev: { updated: iso(Date.now()), ...ev }, seq: c.seq }); }
function cancel(calId, id) { const c = cal(calId); const cur = c.events.get(id); c.seq++; c.events.set(id, { ev: { id, status: 'cancelled', ...(cur && cur.ev.recurringEventId ? { recurringEventId: cur.ev.recurringEventId } : {}) }, seq: c.seq }); }
const timed = (id, startMs, title, extra = {}) => ({ id, status: 'confirmed', summary: title, start: { dateTime: iso(startMs) }, end: { dateTime: iso(startMs + H) }, ...extra });

globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  if (u.host === 'oauth2.googleapis.com') {
    google.tokenCalls++;
    const p = new URLSearchParams(opts.body);
    assert.equal(p.get('grant_type'), 'refresh_token');
    if (google.failToken) return res(400, { error: google.failToken });
    return res(200, { access_token: 'at-1', expires_in: 3600 });
  }
  if (u.pathname === '/calendar/v3/freeBusy') {
    assert.equal(opts.method, 'POST'); assert.equal(opts.headers.Authorization, 'Bearer at-1');
    const q = JSON.parse(opts.body);
    assert.ok(q.timeMin && q.timeMax && q.items.length === 1);
    const id = q.items[0].id;
    if (google.fbFail) return res(200, { calendars: { [id]: { errors: [{ domain: 'global', reason: 'notFound' }], busy: [] } } });
    google.fbWindows.push([q.timeMin, q.timeMax]);
    // Like Google: blocks are clipped to the query window
    const clip = (b) => ({ start: b.start < q.timeMin ? q.timeMin : b.start, end: b.end > q.timeMax ? q.timeMax : b.end });
    return res(200, { calendars: { [id]: { busy: (google.busy[id] || []).filter(b => b.end > q.timeMin && b.start < q.timeMax).map(clip) } } });
  }
  const m = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
  assert.ok(m, 'unexpected url ' + url);
  assert.equal(opts.headers.Authorization, 'Bearer at-1');
  assert.equal(u.searchParams.get('showDeleted'), 'true');
  assert.equal(u.searchParams.get('singleEvents'), 'true');
  google.listCalls++;
  const c = cal(decodeURIComponent(m[1]));
  let list;
  const st = u.searchParams.get('syncToken');
  if (st) {
    assert.ok(!u.searchParams.has('timeMin'), 'no timeMin with syncToken');
    const since = Number(st.split('-').pop());
    if (since < c.validFrom) return res(410, { error: { code: 410, message: 'Sync token is no longer valid' } });
    list = [...c.events.values()].filter(e => e.seq > since).map(e => e.ev);
  } else {
    const a = u.searchParams.get('timeMin'), b = u.searchParams.get('timeMax');
    assert.ok(a && b, 'full sync has a window');
    list = [...c.events.values()].map(e => e.ev).filter(ev => ev.status === 'cancelled' || (ev.end && (ev.end.dateTime || ev.end.date) > a && (ev.start.dateTime || ev.start.date) < b));
  }
  const off = Number(u.searchParams.get('pageToken') || 0);
  const page = list.slice(off, off + google.pageSize);
  const more = off + google.pageSize < list.length;
  return res(200, { items: page, ...(more ? { nextPageToken: String(off + google.pageSize) } : { nextSyncToken: `tok-${c.seq}` }) });
};

const { runCalendarSync, zonedMidnight } = await import('../src/gcal.js');
const worker = (await import('../src/index.js')).default;
const SECRETS = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'cs', GOOGLE_REFRESH_TOKEN: 'rt' };
const env = { DB, AGENT_KEY: 'k', APP_PASSPHRASE: 'dev', ASSETS: { fetch: async () => new Response('asset') }, ...SECRETS, CALENDAR_IDS: 'cal-a, cal-b' };

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.equal(a, b, m); checks++; };
const emitted = [];
const sync = (opts = {}) => runCalendarSync(env, { emit: (k, p) => emitted.push([k, p]), ...opts });
const ev = (calId, id) => sqlite.prepare('SELECT * FROM calendar_events WHERE calendar_id = ? AND event_id = ?').get(calId, id);
const changes = () => sqlite.prepare('SELECT * FROM calendar_changes ORDER BY at, rowid').all();
const cursor = (calId) => sqlite.prepare("SELECT * FROM sync_cursors WHERE source = 'gcal_sync' AND scope = ?").get(calId);
const health = () => sqlite.prepare("SELECT * FROM source_health WHERE source = 'gcal_sync'").get();
async function agent(p) {
  const r = await worker.fetch(new Request('https://x.test' + p, { headers: { authorization: 'Bearer k' } }), env, ctx);
  await flush();
  return { status: r.status, data: await r.json() };
}

// Timezone helper: all-day dates are midnight in the calendar's zone
eq(zonedMidnight('2026-01-15', 'America/Los_Angeles'), '2026-01-15T08:00:00.000Z');
eq(zonedMidnight('2026-07-15', 'America/Los_Angeles'), '2026-07-15T07:00:00.000Z');
eq(zonedMidnight('2026-07-15', 'UTC'), '2026-07-15T00:00:00.000Z');

// Not configured: no Google calls, health says so
{
  const bare = { DB, CALENDAR_IDS: 'cal-a' };
  const r = await runCalendarSync(bare);
  eq(r.configured, false); eq(google.tokenCalls, 0);
  eq(health().last_error, 'not configured'); eq(health().last_ok, null);
}

// Initial full sync: baseline, no change rows, cursor stored, pagination followed
put('cal-a', timed('e1', NOW + DAY, 'Dentist', { location: 'Main St' }));
put('cal-a', timed('e2', NOW + 2 * DAY, 'Standup', { attendees: [{ email: 'x', self: true, responseStatus: 'accepted' }, { email: 'y' }] }));
put('cal-a', { id: 'e3', status: 'confirmed', summary: 'Holiday', start: { date: iso(NOW + 5 * DAY).slice(0, 10) }, end: { date: iso(NOW + 6 * DAY).slice(0, 10) } });
put('cal-a', timed('far', NOW + 90 * DAY, 'Outside window'));
put('cal-a', timed('s1_1', NOW + 3 * DAY, 'Weekly', { recurringEventId: 's1' }));
put('cal-a', timed('s1_2', NOW + 10 * DAY, 'Weekly', { recurringEventId: 's1' }));
put('cal-b', timed('b1', NOW + DAY, 'Other cal'));
let r = await sync();
eq(r.results.length, 2);
eq(r.results[0].mode, 'initial'); ok(r.results[0].pages >= 3, 'paginated');
eq(changes().length, 0, 'baseline writes no change rows');
ok(ev('cal-a', 'e1') && ev('cal-a', 'e2') && ev('cal-b', 'b1'), 'stored');
eq(ev('cal-a', 'far'), undefined, 'outside the initial window');
eq(ev('cal-a', 'e1').location, 'Main St');
eq(JSON.parse(ev('cal-a', 'e2').attendees).self, 'accepted');
eq(ev('cal-a', 'e3').all_day, 1);
ok(cursor('cal-a').cursor && cursor('cal-a').last_full_sync, 'cursor + full sync time');
ok(health().last_ok && !health().last_error, 'healthy');
eq(health().stale_after_hours, 1);
eq(emitted.filter(e => e[1].mode === 'initial').length, 2, 'initial runs logged');

// Quiet incremental: no changes, nothing logged
emitted.length = 0;
r = await sync();
eq(r.results[0].mode, 'incremental'); eq(r.results[0].events, 0);
eq(emitted.length, 0, 'quiet runs emit nothing');

// Incremental add / move / rename / attendee-only / cancel
put('cal-a', timed('e4', NOW + 4 * DAY, 'New thing'));
put('cal-a', timed('e1', NOW + DAY + 2 * H, 'Dentist', { location: 'Main St' }));
put('cal-a', timed('e2', NOW + 2 * DAY, 'Team standup', { attendees: [{ email: 'x', self: true, responseStatus: 'accepted' }, { email: 'y' }] }));
put('cal-b', timed('b1', NOW + DAY, 'Other cal', { attendees: [{ email: 'z', self: true, responseStatus: 'declined' }] }));
cancel('cal-a', 'e3');
r = await sync();
const a = r.results.find(x => x.calendar === 'cal-a');
eq(a.mode, 'incremental'); eq(a.added, 1); eq(a.changed, 2); eq(a.cancelled, 1);
eq(r.results.find(x => x.calendar === 'cal-b').changed, 0, 'attendee-only is not a change');
eq(JSON.parse(ev('cal-b', 'b1').attendees).self, 'declined', 'but the row is updated');
const ch = changes();
eq(ch.length, 4);
const moved = ch.find(c => c.event_id === 'e1');
eq(moved.kind, 'changed'); eq(moved.via, 'incremental'); eq(moved.calendar_id, 'cal-a');
eq(JSON.parse(moved.before).start, iso(NOW + DAY)); eq(JSON.parse(moved.after).start, iso(NOW + DAY + 2 * H));
eq(JSON.parse(ev('cal-a', 'e1').prev).start, iso(NOW + DAY), 'prev kept');
eq(JSON.parse(ch.find(c => c.event_id === 'e2').after).title, 'Team standup');
const cx = ch.find(c => c.event_id === 'e3');
eq(cx.kind, 'cancelled'); eq(JSON.parse(cx.before).title, 'Holiday'); eq(cx.after, null);
ok(ev('cal-a', 'e3').removed_at, 'removed_at set'); eq(ev('cal-a', 'e3').status, 'cancelled');
eq(ch.find(c => c.event_id === 'e4').kind, 'added');
ok(emitted.some(e => e[0] === 'calendar_sync' && e[1].calendar === 'cal-a' && e[1].changed === 2), 'calendar_sync emitted');

// Idempotent: replaying the same pages (cursor not advanced) changes nothing
{
  const saved = cursor('cal-a').cursor;
  put('cal-a', timed('e5', NOW + 5 * DAY, 'Replay me'));
  await sync();
  const n = changes().length;
  sqlite.prepare("UPDATE sync_cursors SET cursor = ? WHERE scope = 'cal-a'").run(saved);
  r = await sync();
  eq(changes().length, n, 'replay logs nothing new');
  eq(r.results[0].added + r.results[0].changed + r.results[0].cancelled, 0);
}

// Failed write: cursor does not advance, error recorded, next run picks the change up
{
  const before = cursor('cal-a').cursor;
  put('cal-a', timed('e6', NOW + 6 * DAY, 'After failure'));
  failBatch = true;
  r = await sync();
  failBatch = false;
  ok(r.results.every(x => x.error), 'errors reported');
  eq(cursor('cal-a').cursor, before, 'cursor unchanged');
  ok(cursor('cal-a').last_error.includes('batch'), 'cursor error');
  ok(health().last_error.includes('cal-a'), 'health error');
  eq(ev('cal-a', 'e6'), undefined);
  r = await sync();
  eq(r.results[0].added, 1); ok(ev('cal-a', 'e6'));
  eq(cursor('cal-a').last_error, null); eq(health().last_error, null);
}

// Series cancellation cascades to stored future instances
cancel('cal-a', 's1');
r = await sync();
eq(r.results[0].cancelled, 2);
ok(ev('cal-a', 's1_1').removed_at && ev('cal-a', 's1_2').removed_at, 'instances cancelled');
// If Google then also sends the instance tombstones, they are no-ops
cancel('cal-a', 's1_1'); cancel('cal-a', 's1_2');
r = await sync();
eq(r.results[0].cancelled, 0);

// A cancelled event that comes back is added again
put('cal-a', timed('e3', NOW + 20 * DAY, 'Holiday moved'));
r = await sync();
eq(r.results[0].added, 1); eq(ev('cal-a', 'e3').removed_at, null);

// 410: full resync of the window, diffed (missing -> cancelled via resync)
{
  const c = cal('cal-a');
  c.events.delete('e4'); // vanished without a tombstone
  c.validFrom = c.seq + 1;
  put('cal-a', timed('e7', NOW + 7 * DAY, 'During outage'));
  r = await sync();
  const ra = r.results.find(x => x.calendar === 'cal-a');
  eq(ra.mode, 'resync'); eq(ra.added, 1); eq(ra.cancelled, 1);
  const gone = changes().filter(x => x.event_id === 'e4').pop();
  eq(gone.kind, 'cancelled'); eq(gone.via, 'resync');
  ok(ev('cal-a', 'e4').removed_at);
  c.validFrom = 0;
  r = await sync();
  eq(r.results[0].mode, 'incremental', 'back to incremental with the new token');
}

// Daily forced full resync with nothing changed: no change rows
{
  const n = changes().length;
  r = await sync({ forceFull: true });
  eq(r.results[0].mode, 'resync'); eq(changes().length, n, 'no-op resync');
}

// Page cap: too many pages -> error, cursor kept
{
  const keep = cursor('cal-b').cursor;
  google.pageSize = 1;
  for (let i = 0; i < 25; i++) put('cal-b', timed('bp' + i, NOW + DAY, 'p'));
  r = await sync();
  const rb = r.results.find(x => x.calendar === 'cal-b');
  ok(rb.error && rb.error.includes('pages'), rb.error);
  eq(cursor('cal-b').cursor, keep);
  google.pageSize = 50;
  r = await sync();
  eq(r.results.find(x => x.calendar === 'cal-b').added, 25);
}

// Token failure: health records it, no calendar calls
{
  google.failToken = 'invalid_grant';
  const calls = google.listCalls;
  r = await sync();
  ok(r.error.includes('refresh token'), r.error);
  eq(google.listCalls, calls);
  ok(health().last_error.includes('refresh token'));
  google.failToken = null;
  await sync();
  eq(health().last_error, null);
}

// Agent endpoints
{
  let res = await agent('/api/agent/calendar/changes?since=' + encodeURIComponent(iso(NOW - DAY)));
  eq(res.status, 200); ok(res.data.count >= 8, String(res.data.count));
  const c1 = res.data.changes.find(c => c.event_id === 'e1');
  eq(c1.title, 'Dentist'); eq(c1.kind, 'changed'); ok(c1.before && c1.after);
  const c3 = res.data.changes.find(c => c.event_id === 'e3' && c.kind === 'cancelled');
  eq(c3.title, 'Holiday', 'cancelled title from before');
  res = await agent('/api/agent/calendar/changes?since=' + encodeURIComponent(iso(Date.now() + DAY)));
  eq(res.data.count, 0);
  res = await agent('/api/agent/calendar/changes?since=nope'); eq(res.status, 400);
  res = await agent(`/api/agent/calendar/events?start=${encodeURIComponent(iso(NOW))}&end=${encodeURIComponent(iso(NOW + 30 * DAY))}`);
  eq(res.status, 200);
  ok(res.data.events.some(e => e.event_id === 'e1' && e.calendar_id === 'cal-a' && e.prev), 'event with prev');
  ok(res.data.events.some(e => e.calendar_id === 'cal-b'), 'both calendars');
  ok(!res.data.events.some(e => e.removed_at), 'removed hidden');
  const starts = res.data.events.map(e => e.start_ts);
  ok(starts.every((s, i) => i === 0 || starts[i - 1] <= s), 'sorted');
  res = await agent(`/api/agent/calendar/events?start=${encodeURIComponent(iso(NOW))}&end=${encodeURIComponent(iso(NOW + 30 * DAY))}&include_removed=1`);
  ok(res.data.events.some(e => e.event_id === 'e4' && e.removed_at), 'removed on request');
  res = await agent('/api/agent/calendar/events');
  eq(res.status, 200); ok(Date.parse(res.data.end) - Date.parse(res.data.start) === 7 * DAY, 'default 7 days');
  res = await agent('/api/agent/calendar/events?start=bad'); eq(res.status, 400);
  res = await agent(`/api/agent/calendar/events?start=${encodeURIComponent(iso(NOW))}&end=${encodeURIComponent(iso(NOW - DAY))}`); eq(res.status, 400);
  res = await agent('/api/agent/health');
  ok(res.data.sources.some(s => s.source === 'gcal_sync'));
  const cur = res.data.cursors.find(c => c.scope === 'cal-a');
  ok(cur.has_cursor && cur.lag_minutes === 0 && !('cursor' in cur), 'cursor health without the token');
}

// P1b: free/busy-only calendars
{
  env.FREEBUSY_IDS = 'fb-1, cal-a';
  const blk = (h1, h2) => ({ start: iso(NOW + h1 * H), end: iso(NOW + h2 * H) });
  google.busy['fb-1'] = [blk(24, 25), blk(48, 50)];
  r = await sync();
  const f = r.results.find(x => x.calendar === 'fb-1');
  eq(f.mode, 'freebusy'); eq(f.events, 2); ok(f.baseline, 'first read is a baseline');
  eq(r.results.filter(x => x.calendar === 'cal-a').length, 1, 'a calendar in both lists syncs in full only');
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes WHERE calendar_id = 'fb-1'").get().n, 0);
  const rows = sqlite.prepare("SELECT * FROM calendar_events WHERE calendar_id = 'fb-1' ORDER BY start_ts").all();
  eq(rows.length, 2); eq(rows[0].title, 'busy'); eq(rows[0].status, 'busy'); eq(rows[0].location, null); eq(rows[0].attendees, null);
  // Unchanged: nothing logged
  r = await sync();
  eq(r.results.find(x => x.calendar === 'fb-1').added + r.results.find(x => x.calendar === 'fb-1').cancelled, 0);
  // Block moved + new block: moved = cancelled + added
  google.busy['fb-1'] = [blk(24, 25), blk(52, 54), blk(72, 73)];
  r = await sync();
  const f2 = r.results.find(x => x.calendar === 'fb-1');
  eq(f2.added, 2); eq(f2.cancelled, 1);
  const fbc = sqlite.prepare("SELECT * FROM calendar_changes WHERE calendar_id = 'fb-1'").all();
  ok(fbc.every(c => c.via === 'freebusy'), 'via freebusy');
  eq(JSON.parse(fbc.find(c => c.kind === 'added').after).title, 'busy');
  // Errors from Google keep the stored blocks
  google.fbFail = true;
  r = await sync();
  ok(r.results.find(x => x.calendar === 'fb-1').error.includes('notFound'));
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_events WHERE calendar_id = 'fb-1' AND removed_at IS NULL").get().n, 3);
  google.fbFail = false;
  await sync();
  const res = await agent(`/api/agent/calendar/events?start=${encodeURIComponent(iso(NOW))}&end=${encodeURIComponent(iso(NOW + 5 * DAY))}`);
  const fe = res.data.events.filter(e => e.calendar_id === 'fb-1');
  eq(fe.length, 3); ok(fe.every(e => e.free_busy && e.title === 'busy'), 'marked free/busy');
  ok(res.data.events.some(e => e.calendar_id === 'cal-a' && e.free_busy === false), 'normal events are not');
  delete env.FREEBUSY_IDS;
}

// B41: free/busy window snapped to local days; edge-clipped blocks don't churn the change log
{
  const { freeBusyWindow } = await import('../src/gcal.js');
  const w = freeBusyWindow('America/Los_Angeles', Date.parse('2026-10-09T18:00:00Z'));
  eq(w.winStart, '2026-10-02T07:00:00.000Z'); eq(w.winEnd, '2026-12-09T08:00:00.000Z', 'end of day +60 (PST after DST)');
  eq(JSON.stringify(freeBusyWindow('UTC', Date.parse('2026-10-09T23:59:00Z'))), JSON.stringify({ winStart: '2026-10-02T00:00:00.000Z', winEnd: '2026-12-09T00:00:00.000Z' }));
  env.FREEBUSY_IDS = 'fb-edge'; env.CALENDAR_TZ = 'UTC';
  const n0 = sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes WHERE calendar_id = 'fb-edge'").get().n;
  const fbw = freeBusyWindow('UTC');
  // One block straddling the window start, one straddling the end, one in the middle
  google.busy['fb-edge'] = [
    { start: iso(Date.parse(fbw.winStart) - 2 * H), end: iso(Date.parse(fbw.winStart) + 2 * H) },
    { start: iso(Date.parse(fbw.winEnd) - H), end: iso(Date.parse(fbw.winEnd) + 5 * H) },
    { start: iso(NOW + 3 * DAY), end: iso(NOW + 3 * DAY + H) },
  ];
  await sync(); // baseline
  const runs = google.fbWindows.length;
  await sync(); await sync();
  eq(new Set(google.fbWindows.slice(runs - 1).map(x => x.join('|'))).size, 1, 'same window on every run within a day');
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes WHERE calendar_id = 'fb-edge'").get().n, n0, 'no churn');
  // Simulate the edge moving (stored edge rows from an older window): clipped versions are swapped silently
  sqlite.prepare("UPDATE calendar_events SET event_id = 'busy:old-edge', start_ts = ? WHERE calendar_id = 'fb-edge' AND start_ts = ?").run(iso(Date.parse(fbw.winStart) - 30 * 60000), fbw.winStart);
  await sync();
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes WHERE calendar_id = 'fb-edge'").get().n, n0, 'edge swap not logged');
  ok(sqlite.prepare("SELECT removed_at FROM calendar_events WHERE event_id = 'busy:old-edge'").get().removed_at, 'old edge row removed');
  // A real change mid-window is still logged
  google.busy['fb-edge'][2] = { start: iso(NOW + 4 * DAY), end: iso(NOW + 4 * DAY + H) };
  await sync();
  const kinds = sqlite.prepare("SELECT kind FROM calendar_changes WHERE calendar_id = 'fb-edge' ORDER BY rowid").all().slice(n0).map(r => r.kind).sort();
  eq(JSON.stringify(kinds), JSON.stringify(['added', 'cancelled']), 'mid-window move logged');
  delete env.FREEBUSY_IDS; delete env.CALENDAR_TZ;
}

// Retention: events ended > 365 days ago and changes > 90 days ago are purged; recent ones stay
{
  const { purgeCalendar } = await import('../src/gcal.js');
  sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, first_seen, last_seen) VALUES ('owner', 'cal-a', 'old', ?, ?, ?, ?)")
    .run(iso(NOW - 400 * DAY), iso(NOW - 400 * DAY + H), iso(NOW), iso(NOW));
  sqlite.prepare("INSERT INTO calendar_events (tenant_id, calendar_id, event_id, start_ts, end_ts, first_seen, last_seen) VALUES ('owner', 'cal-a', 'last-year', ?, ?, ?, ?)")
    .run(iso(NOW - 300 * DAY), iso(NOW - 300 * DAY + H), iso(NOW), iso(NOW));
  sqlite.prepare("INSERT INTO calendar_changes (id, tenant_id, calendar_id, event_id, kind, at) VALUES ('cc-old', 'owner', 'cal-a', 'x', 'added', ?)").run(iso(NOW - 100 * DAY));
  await purgeCalendar(env);
  eq(ev('cal-a', 'old'), undefined); ok(ev('cal-a', 'last-year'), 'kept within a year');
  eq(sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes WHERE id = 'cc-old'").get().n, 0);
  ok(changes().length > 0, 'recent changes kept');
}

// On-demand sync endpoint
{
  const calls = google.listCalls;
  const res = await worker.fetch(new Request('https://x.test/api/agent/calendar/sync', { method: 'POST', headers: { authorization: 'Bearer k' } }), env, ctx);
  await flush();
  const body = await res.json();
  eq(res.status, 200); eq(body.configured, true); ok(google.listCalls > calls, 'synced');
  ok(!JSON.stringify(body).includes('at-1') && !JSON.stringify(body).includes('tok-'), 'no tokens in the response');
  const full = await (await worker.fetch(new Request('https://x.test/api/agent/calendar/sync?full=1', { method: 'POST', headers: { authorization: 'Bearer k' } }), env, ctx)).json();
  await flush();
  ok(full.results.some(x => x.mode === 'resync'), 'full=1 resyncs');
  const noauth = await worker.fetch(new Request('https://x.test/api/agent/calendar/sync', { method: 'POST' }), env, ctx);
  eq(noauth.status, 401);
}

// Cron dispatch: */10 runs the sync; the daily cron resyncs + purges and still purges items
{
  const calls = google.listCalls;
  await worker.scheduled({ cron: '*/10 * * * *' }, env, ctx); await flush();
  ok(google.listCalls > calls, '10-min cron synced');
  const before = cursor('cal-a').last_full_sync;
  await new Promise(r => setTimeout(r, 5));
  await worker.scheduled({ cron: '17 11 * * *' }, env, ctx); await flush();
  ok(cursor('cal-a').last_full_sync > before, 'daily cron did a full resync');
  const ticks = sqlite.prepare("SELECT props FROM events WHERE kind = 'cron_tick'").all().map(r => JSON.parse(r.props));
  ok(ticks.some(t => t.cron === '*/10 * * * *') && ticks.some(t => t.cron === '17 11 * * *'), 'cron ticks recorded');
  ok(sqlite.prepare("SELECT last_error FROM source_health WHERE source = 'cron_tick'").get().last_error.startsWith('last cron: '), 'tick mirrored in source_health');
  const n = sqlite.prepare("SELECT COUNT(*) AS n FROM calendar_changes").get().n, calls2 = google.listCalls;
  await worker.scheduled({ cron: '1 2 * * *' }, env, ctx); await flush();
  eq(google.listCalls, calls2, 'unknown cron does nothing'); ok(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'cron_tick'").get().n >= 3);
  await worker.scheduled({ cron: ' */10  * * * * ', scheduledTime: Date.now() }, env, ctx); await flush();
  ok(google.listCalls > calls2, 'whitespace-normalized match'); void n;
  const ver = await worker.fetch(new Request('https://x.test/api/agent/version', { headers: { authorization: 'Bearer k' } }), { ...env, CF_VERSION_METADATA: { id: 'v-1', tag: '', timestamp: 't' } }, ctx);
  eq((await ver.json()).version, 'v-1');
}

console.log(`test-calendar-sync: ${checks} checks passed`);
