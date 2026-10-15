// B37 P1: Google Calendar collector. A Worker cron pulls changes with sync tokens into D1.
// Read-only toward Google (calendar.readonly).

const SOURCE = 'gcal_sync'; // distinct from agent-ingested sources so health rows never collide
const PAGE_SIZE = 250;
const MAX_PAGES = 20;
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 60;
const CHUNK = 200; // rows per json_each statement
const COMPARE = ['start_ts', 'end_ts', 'all_day', 'title', 'location', 'status'];
const DAY = 86400000;

export function calendarConfig(env) {
  const list = (v) => [...new Set(String(v || '').split(',').map(s => s.trim()).filter(Boolean))];
  const ids = env.CALENDAR_IDS ? list(env.CALENDAR_IDS) : ['primary'];
  return {
    configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN),
    ids,
    // P1b: calendars we can only see as free/busy (a calendar in both lists is synced in full)
    freebusyIds: list(env.FREEBUSY_IDS).filter(id => !ids.includes(id)),
    tz: env.CALENDAR_TZ || 'America/Los_Angeles',
  };
}

// Offset of tz from UTC at instant t, in ms
function tzOffsetMs(t, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}

// Midnight of a YYYY-MM-DD date in tz, as an ISO UTC string
export function zonedMidnight(date, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  let t = base;
  for (let i = 0; i < 2; i++) t = base - tzOffsetMs(t, tz);
  return new Date(t).toISOString();
}

function todayIn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// Shared with the mail collector: returns the token response ({ access_token, scope, ... })
export async function mintGoogleToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
    }).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') throw new Error('refresh token revoked or expired (re-run the token script)');
    throw new Error(`token ${res.status}${data.error ? ' ' + data.error : ''}`);
  }
  return data;
}

class GoneError extends Error {}

// All pages of events.list. Returns { events, nextSyncToken, pages }. Throws GoneError on 410.
async function listEvents(token, calId, params) {
  const events = [];
  let pageToken = null;
  for (let pages = 1; pages <= MAX_PAGES; pages++) {
    const q = new URLSearchParams({ ...params, showDeleted: 'true', singleEvents: 'true', maxResults: String(PAGE_SIZE) });
    if (pageToken) q.set('pageToken', pageToken);
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 410) throw new GoneError('sync token expired');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`events.list ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
    }
    const data = await res.json();
    events.push(...(data.items || []));
    if (data.nextPageToken) { pageToken = data.nextPageToken; continue; }
    if (!data.nextSyncToken) throw new Error('events.list returned no nextSyncToken');
    return { events, nextSyncToken: data.nextSyncToken, pages };
  }
  throw new Error(`more than ${MAX_PAGES} pages; cursor not advanced`);
}

// Google event -> stored row shape (null for an event without times, e.g. a bare cancellation)
function normalize(ev, tz) {
  if (!ev.start || !ev.end) return null;
  const allDay = !!ev.start.date;
  const ts = (x) => (x.date ? zonedMidnight(x.date, tz) : new Date(x.dateTime).toISOString());
  let attendees = null;
  if (Array.isArray(ev.attendees) && ev.attendees.length) {
    const self = ev.attendees.find(a => a.self);
    attendees = { count: ev.attendees.length, self: self ? self.responseStatus || null : null };
  }
  return {
    event_id: ev.id, recurring_event_id: ev.recurringEventId || null,
    start_raw: ev.start.date || ev.start.dateTime, end_raw: ev.end.date || ev.end.dateTime,
    start_ts: ts(ev.start), end_ts: ts(ev.end), all_day: allDay ? 1 : 0,
    title: ev.summary ? String(ev.summary).slice(0, 300) : null,
    location: ev.location ? String(ev.location).slice(0, 300) : null,
    status: ev.status || 'confirmed', attendees, updated: ev.updated || null,
  };
}

// The before/after shape agents see
const view = (r) => (r ? { start: r.start_raw, end: r.end_raw, all_day: !!r.all_day, title: r.title, location: r.location, status: r.status } : null);
const differs = (a, b) => COMPARE.some(k => (a[k] ?? null) !== (b[k] ?? null));
const chunks = (arr) => { const out = []; for (let i = 0; i < arr.length; i += CHUNK) out.push(arr.slice(i, i + CHUNK)); return out; };
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');

// Apply one sync's writes in a single D1 batch. The cursor advances in the same batch as the data,
// so it only moves if the writes commit.
async function writeSync(DB, calId, nowIso, { upserts, cancels, missing, changes, via, cursor, full }) {
  const stmts = [];
  for (const c of chunks(upserts)) {
    stmts.push(DB.prepare(
      `INSERT INTO calendar_events (tenant_id, calendar_id, event_id, recurring_event_id, start_raw, end_raw, start_ts, end_ts, all_day, title, location, status, attendees, updated, first_seen, last_seen, removed_at, prev)
       SELECT 'owner', ?1, json_extract(value, '$.event_id'), json_extract(value, '$.recurring_event_id'), json_extract(value, '$.start_raw'), json_extract(value, '$.end_raw'),
         json_extract(value, '$.start_ts'), json_extract(value, '$.end_ts'), json_extract(value, '$.all_day'), json_extract(value, '$.title'), json_extract(value, '$.location'),
         json_extract(value, '$.status'), json_extract(value, '$.attendees'), json_extract(value, '$.updated'), ?2, ?2, NULL, json_extract(value, '$.prev')
       FROM json_each(?3) WHERE true
       ON CONFLICT(tenant_id, calendar_id, event_id) DO UPDATE SET recurring_event_id = excluded.recurring_event_id, start_raw = excluded.start_raw, end_raw = excluded.end_raw,
         start_ts = excluded.start_ts, end_ts = excluded.end_ts, all_day = excluded.all_day, title = excluded.title, location = excluded.location, status = excluded.status,
         attendees = excluded.attendees, updated = excluded.updated, last_seen = excluded.last_seen, removed_at = NULL, prev = COALESCE(excluded.prev, prev)`
    ).bind(calId, nowIso, JSON.stringify(c)));
  }
  for (const c of chunks(cancels)) {
    stmts.push(DB.prepare("UPDATE calendar_events SET removed_at = ?1, status = 'cancelled', last_seen = ?1 WHERE tenant_id = 'owner' AND calendar_id = ?2 AND event_id IN (SELECT value FROM json_each(?3))")
      .bind(nowIso, calId, JSON.stringify(c)));
  }
  for (const c of chunks(missing)) {
    stmts.push(DB.prepare("UPDATE calendar_events SET removed_at = ?1 WHERE tenant_id = 'owner' AND calendar_id = ?2 AND event_id IN (SELECT value FROM json_each(?3))")
      .bind(nowIso, calId, JSON.stringify(c)));
  }
  for (const c of chunks(changes)) {
    stmts.push(DB.prepare(
      `INSERT INTO calendar_changes (id, tenant_id, calendar_id, event_id, kind, at, before, after, via)
       SELECT json_extract(value, '$.id'), 'owner', ?1, json_extract(value, '$.event_id'), json_extract(value, '$.kind'), ?2,
         json_extract(value, '$.before'), json_extract(value, '$.after'), ?3 FROM json_each(?4)`
    ).bind(calId, nowIso, via, JSON.stringify(c)));
  }
  stmts.push(DB.prepare(
    `INSERT INTO sync_cursors (tenant_id, source, scope, cursor, last_ok, last_attempt, last_error, last_full_sync) VALUES ('owner', ?1, ?2, ?3, ?4, ?4, NULL, ?5)
     ON CONFLICT(tenant_id, source, scope) DO UPDATE SET cursor = excluded.cursor, last_ok = excluded.last_ok, last_attempt = excluded.last_attempt, last_error = NULL,
       last_full_sync = COALESCE(excluded.last_full_sync, last_full_sync)`
  ).bind(SOURCE, calId, cursor, nowIso, full ? nowIso : null));
  await DB.batch(stmts);
}

// Sync one calendar. forceFull re-reads the whole window (daily resync). Writes everything in one batch.
async function syncCalendar(env, token, calId, tz, { forceFull = false } = {}) {
  const DB = env.DB;
  const started = Date.now();
  const nowIso = new Date().toISOString();
  const cur = await DB.prepare("SELECT * FROM sync_cursors WHERE tenant_id = 'owner' AND source = ? AND scope = ?").bind(SOURCE, calId).first();
  const storedRows = (await DB.prepare("SELECT * FROM calendar_events WHERE tenant_id = 'owner' AND calendar_id = ?").bind(calId).all()).results || [];
  const stored = new Map(storedRows.map(r => [r.event_id, r]));

  const winStart = new Date(Date.now() - WINDOW_PAST_DAYS * DAY).toISOString();
  const winEnd = new Date(Date.now() + WINDOW_FUTURE_DAYS * DAY).toISOString();
  let mode, result;
  if (cur && cur.cursor && !forceFull) {
    try { mode = 'incremental'; result = await listEvents(token, calId, { syncToken: cur.cursor }); }
    catch (e) { if (!(e instanceof GoneError)) throw e; mode = 'resync'; }
  } else {
    mode = storedRows.length ? 'resync' : 'initial';
  }
  if (mode !== 'incremental') result = await listEvents(token, calId, { timeMin: winStart, timeMax: winEnd });
  const logChanges = mode !== 'initial'; // the first sync is the baseline

  const incoming = new Map();
  for (const ev of result.events) if (ev && ev.id) incoming.set(ev.id, ev);

  const upserts = [], changes = [], cancels = [], missing = [];
  const change = (kind, eventId, before, after) => { if (logChanges) changes.push({ id: 'cc-' + newId(), event_id: eventId, kind, before, after }); };
  const cancelled = new Set();
  const cancelStored = (row) => {
    if (cancelled.has(row.event_id)) return;
    cancelled.add(row.event_id); cancels.push(row.event_id); change('cancelled', row.event_id, view(row), null);
  };

  for (const ev of incoming.values()) {
    const old = stored.get(ev.id);
    if (ev.status === 'cancelled') {
      if (old && !old.removed_at) cancelStored(old);
      // A cancelled series: cancel its stored future instances too
      for (const r of storedRows) {
        if (r.recurring_event_id === ev.id && !r.removed_at && r.end_ts > nowIso && !incoming.has(r.event_id)) cancelStored(r);
      }
      continue;
    }
    const row = normalize(ev, tz);
    if (!row) continue;
    if (!old || old.removed_at) {
      change('added', row.event_id, null, view(row));
      upserts.push({ ...row, prev: null });
    } else if (differs(row, old)) {
      change('changed', row.event_id, view(old), view(row));
      upserts.push({ ...row, prev: { ...view(old), changed_at: nowIso } });
    } else {
      upserts.push({ ...row, prev: null });
    }
  }
  // A full read is complete for its window: stored events overlapping it that didn't come back are gone
  if (mode !== 'incremental') {
    for (const r of storedRows) {
      if (!r.removed_at && !incoming.has(r.event_id) && !cancelled.has(r.event_id) && r.end_ts > winStart && r.start_ts < winEnd) { missing.push(r.event_id); change('cancelled', r.event_id, view(r), null); }
    }
  }

  await writeSync(DB, calId, nowIso, { upserts, cancels, missing, changes, via: mode === 'incremental' ? 'incremental' : 'resync', cursor: result.nextSyncToken, full: mode !== 'incremental' });

  const count = (k) => changes.filter(c => c.kind === k).length;
  return { calendar: calId, mode, pages: result.pages, added: count('added'), changed: count('changed'), cancelled: count('cancelled'), events: incoming.size, ms: Date.now() - started };
}

// Free/busy window snapped to local days; blocks within a day of either edge count as edge blocks
export function freeBusyWindow(tz, now = Date.now()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  const day = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * DAY).toISOString().slice(0, 10);
  return { winStart: zonedMidnight(day(-WINDOW_PAST_DAYS), tz), winEnd: zonedMidnight(day(WINDOW_FUTURE_DAYS + 1), tz) };
}
const nearEdge = (r, winStart, winEnd) => r.start_ts < new Date(Date.parse(winStart) + DAY).toISOString() || r.end_ts > new Date(Date.parse(winEnd) - DAY).toISOString();

// P1b: a calendar shared as free/busy only. freeBusy.query returns the busy blocks for the window; each
// block is stored as an event titled "busy" with status 'busy' and no details. The result is a complete
// snapshot of the window, so new blocks are added and missing ones cancelled (a moved block = both).
async function syncFreeBusy(env, token, calId, tz) {
  const DB = env.DB;
  const started = Date.now();
  const nowIso = new Date().toISOString();
  // B41: Google clips busy blocks to the query window, so a moving window re-clips edge blocks every run.
  // Snap the window to whole days in tz (start of day -7 .. end of day +60) so the edges move once a day.
  const { winStart, winEnd } = freeBusyWindow(tz);
  const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timeMin: winStart, timeMax: winEnd, items: [{ id: calId }] }),
  });
  if (!res.ok) throw new Error(`freeBusy ${res.status}`);
  const data = await res.json();
  const cal = (data.calendars || {})[calId];
  if (!cal) throw new Error('freeBusy: calendar missing from response');
  if (cal.errors && cal.errors.length) throw new Error('freeBusy: ' + (cal.errors[0].reason || 'error'));

  const storedRows = (await DB.prepare("SELECT * FROM calendar_events WHERE tenant_id = 'owner' AND calendar_id = ?").bind(calId).all()).results || [];
  const stored = new Map(storedRows.map(r => [r.event_id, r]));
  const logChanges = storedRows.length > 0; // the first read is the baseline
  const upserts = [], missing = [], changes = [];
  const change = (kind, eventId, before, after) => { if (logChanges) changes.push({ id: 'cc-' + newId(), event_id: eventId, kind, before, after }); };
  const seen = new Set();
  for (const b of cal.busy || []) {
    const start = new Date(b.start).toISOString(), end = new Date(b.end).toISOString();
    const row = { event_id: `busy:${start}|${end}`, recurring_event_id: null, start_raw: b.start, end_raw: b.end, start_ts: start, end_ts: end,
      all_day: 0, title: 'busy', location: null, status: 'busy', attendees: null, updated: null, prev: null };
    if (seen.has(row.event_id)) continue;
    seen.add(row.event_id);
    const old = stored.get(row.event_id);
    // A block clipped at a window edge is not news (it changes when the edge moves); store it, don't log it
    if ((!old || old.removed_at) && !nearEdge(row, winStart, winEnd)) change('added', row.event_id, null, view(row));
    upserts.push(row);
  }
  for (const r of storedRows) {
    if (!r.removed_at && !seen.has(r.event_id) && r.end_ts > winStart && r.start_ts < winEnd) {
      missing.push(r.event_id);
      if (!nearEdge(r, winStart, winEnd)) change('cancelled', r.event_id, view(r), null);
    }
  }
  await writeSync(DB, calId, nowIso, { upserts, cancels: [], missing, changes, via: 'freebusy', cursor: null, full: true });
  const count = (k) => changes.filter(c => c.kind === k).length;
  return { calendar: calId, mode: 'freebusy', added: count('added'), changed: 0, cancelled: count('cancelled'), events: seen.size, ms: Date.now() - started, ...(logChanges ? {} : { baseline: true }) };
}

async function setHealth(DB, { ok, error }) {
  const nowIso = new Date().toISOString();
  await DB.prepare(
    `INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error, stale_after_hours) VALUES ('owner', ?, ?, ?, ?, 1)
     ON CONFLICT(tenant_id, source) DO UPDATE SET last_ok = COALESCE(excluded.last_ok, last_ok), last_attempt = excluded.last_attempt, last_error = excluded.last_error`
  ).bind(SOURCE, ok ? nowIso : null, nowIso, error || null).run();
}

// Cron entry point. emit(kind, props) logs telemetry. Never throws.
export async function runCalendarSync(env, { forceFull = false, emit = () => {} } = {}) {
  const cfg = calendarConfig(env);
  if (!cfg.configured) { await setHealth(env.DB, { ok: false, error: 'not configured' }); return { configured: false, results: [] }; }
  let token;
  try { token = (await mintGoogleToken(env)).access_token; }
  catch (e) {
    await setHealth(env.DB, { ok: false, error: String(e.message || e).slice(0, 300) });
    emit('calendar_sync', { mode: forceFull ? 'resync' : 'incremental', error: 'token' });
    return { configured: true, error: String(e.message || e), results: [] };
  }
  const results = [];
  const jobs = [...cfg.ids.map(id => [id, false]), ...cfg.freebusyIds.map(id => [id, true])];
  for (const [calId, busyOnly] of jobs) {
    try {
      const r = busyOnly ? await syncFreeBusy(env, token, calId, cfg.tz) : await syncCalendar(env, token, calId, cfg.tz, { forceFull });
      results.push(r);
      if (r.added || r.changed || r.cancelled || (r.mode !== 'incremental' && r.mode !== 'freebusy') || r.baseline) emit('calendar_sync', r);
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      results.push({ calendar: calId, error: msg });
      const nowIso = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO sync_cursors (tenant_id, source, scope, last_attempt, last_error) VALUES ('owner', ?, ?, ?, ?)
         ON CONFLICT(tenant_id, source, scope) DO UPDATE SET last_attempt = excluded.last_attempt, last_error = excluded.last_error`
      ).bind(SOURCE, calId, nowIso, msg).run();
      emit('calendar_sync', { calendar: calId, mode: forceFull ? 'resync' : 'incremental', error: msg.slice(0, 120) });
    }
  }
  const failed = results.filter(r => r.error);
  await setHealth(env.DB, failed.length ? { ok: false, error: failed.map(r => `${r.calendar}: ${r.error}`).join('; ').slice(0, 300) } : { ok: true });
  return { configured: true, results };
}

// Daily retention: events that ended over a year ago, change log entries over 90 days
export async function purgeCalendar(env) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM calendar_events WHERE tenant_id = 'owner' AND end_ts < ?").bind(new Date(now - 365 * DAY).toISOString()),
    env.DB.prepare("DELETE FROM calendar_changes WHERE tenant_id = 'owner' AND at < ?").bind(new Date(now - 90 * DAY).toISOString()),
  ]);
}

const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch (e) { return null; } };

// GET /api/agent/calendar/changes?since=ISO&limit=
export async function calendarChanges(env, url) {
  let since = new Date(Date.now() - DAY).toISOString();
  const s = url.searchParams.get('since');
  if (s) { const t = Date.parse(s); if (isNaN(t)) return { status: 400, body: { error: 'Invalid since' } }; since = new Date(t).toISOString(); }
  let limit = 500;
  if (url.searchParams.has('limit')) { limit = parseInt(url.searchParams.get('limit'), 10); if (!(limit >= 1)) return { status: 400, body: { error: 'Invalid limit' } }; limit = Math.min(limit, 2000); }
  const rows = (await env.DB.prepare("SELECT * FROM calendar_changes WHERE tenant_id = 'owner' AND at > ? ORDER BY at ASC, rowid ASC LIMIT ?").bind(since, limit).all()).results || [];
  const changes = rows.map(r => {
    const before = parseJson(r.before), after = parseJson(r.after);
    return { at: r.at, kind: r.kind, calendar_id: r.calendar_id, event_id: r.event_id, title: (after || before || {}).title ?? null, before, after, via: r.via };
  });
  return { status: 200, body: { since, count: changes.length, changes } };
}

// GET /api/agent/calendar/events?start=ISO&end=ISO&include_removed=1 (events overlapping the window)
export async function calendarEvents(env, url) {
  const { tz } = calendarConfig(env);
  const parse = (k) => { const v = url.searchParams.get(k); if (!v) return null; const t = Date.parse(v); return isNaN(t) ? undefined : new Date(t).toISOString(); };
  let start = parse('start'), end = parse('end');
  if (start === undefined || end === undefined) return { status: 400, body: { error: 'Invalid start/end (ISO 8601)' } };
  start = start || zonedMidnight(todayIn(tz), tz);
  end = end || new Date(Date.parse(start) + 7 * DAY).toISOString();
  if (start >= end) return { status: 400, body: { error: 'start must be before end' } };
  let sql = "SELECT * FROM calendar_events WHERE tenant_id = 'owner' AND end_ts > ? AND start_ts < ?";
  if (url.searchParams.get('include_removed') !== '1') sql += ' AND removed_at IS NULL';
  sql += ' ORDER BY start_ts ASC, title ASC LIMIT 2000';
  const rows = (await env.DB.prepare(sql).bind(start, end).all()).results || [];
  const events = rows.map(r => ({
    calendar_id: r.calendar_id, event_id: r.event_id, recurring_event_id: r.recurring_event_id,
    start: r.start_raw, end: r.end_raw, start_ts: r.start_ts, end_ts: r.end_ts, all_day: !!r.all_day,
    title: r.title, location: r.location, status: r.status, free_busy: r.status === 'busy', attendees: parseJson(r.attendees),
    updated: r.updated, removed_at: r.removed_at, prev: parseJson(r.prev),
  }));
  return { status: 200, body: { start, end, count: events.length, events } };
}

// Per-calendar cursor health for /api/agent/health
export async function cursorHealth(env) {
  const rows = (await env.DB.prepare("SELECT * FROM sync_cursors WHERE tenant_id = 'owner' ORDER BY source, scope").all()).results || [];
  return rows.map(r => ({
    source: r.source, scope: r.scope, has_cursor: !!r.cursor, last_ok: r.last_ok, last_attempt: r.last_attempt, last_error: r.last_error,
    last_full_sync: r.last_full_sync, lag_minutes: r.last_ok ? Math.round((Date.now() - Date.parse(r.last_ok)) / 60000) : null,
  }));
}
