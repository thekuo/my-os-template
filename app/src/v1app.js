// my-os v1 app API (cookie session, same login as v0). The v1 UI loads everything it needs in one call
// (GET /api/v1/state) and writes back small changes. Task rules (completion, repeats, won't do, compat with v0)
// are the shared ones from index.js, passed in as `d`. See design/BUILD-v1.md.
import { validateV1, syncCompat, extrasStmts, decorate, areasList } from './v1.js';
import { zonedMidnight, calendarConfig } from './gcal.js';
import { AUTOMATED_SQL } from './views.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const LOGBOOK_DAYS = 60;
const EVENT_DAYS = 8; // Today + the 7 Upcoming days

async function state(env, d) {
  const today = d.getTodayLA();
  const tz = calendarConfig(env).tz;
  const since = new Date(Date.now() - LOGBOOK_DAYS * 86400000).toISOString();
  const all = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];
  // Open to-dos (incl. pending suggestions and the Claude list), recent Logbook, and Trash
  const rows = await all(`SELECT * FROM tasks WHERE tenant_id = 'owner' AND parent_task_id IS NULL
      AND COALESCE(suggestion_state, 'accepted') != 'dismissed'
      AND (trashed_at IS NOT NULL OR (completed_at IS NULL AND dropped_at IS NULL) OR completed_at >= ? OR dropped_at >= ?)
    ORDER BY COALESCE(sort_index, 1e9), due_date, created_at`, since, since);
  const completions = await all(`SELECT c.id, c.task_id, c.completed_at, t.title, t.area_id, t.area, t.project_id, t.list FROM completions c JOIN tasks t ON t.id = c.task_id
    WHERE c.tenant_id = 'owner' AND c.completed_at >= ? AND t.parent_task_id IS NULL ORDER BY c.completed_at DESC`, since);
  const areas = await areasList(env);
  const headings = await all("SELECT id, project_id, title, sort FROM headings WHERE tenant_id = 'owner' AND archived_at IS NULL ORDER BY sort");
  const start = zonedMidnight(today, tz);
  const end = new Date(Date.parse(start) + EVENT_DAYS * 86400000 + 2 * 3600000).toISOString();
  let events = (await all("SELECT * FROM calendar_events WHERE tenant_id = 'owner' AND removed_at IS NULL AND end_ts > ? AND start_ts < ? ORDER BY start_ts LIMIT 1000", start, end))
    .map(r => ({ id: r.calendar_id + '|' + r.event_id, cal: r.calendar_id, start: r.start_ts, end: r.end_ts, all_day: !!r.all_day, start_date: r.all_day ? r.start_raw : null, end_date: r.all_day ? r.end_raw : null, title: r.title, busy: r.status === 'busy' }));
  const labels = (await all("SELECT * FROM event_labels WHERE tenant_id = 'owner'")) || [];
  if (labels.length) events = splitLabeled(labels, events, tz);
  const brief = await env.DB.prepare("SELECT date, body_md, created_at FROM briefs WHERE tenant_id = 'owner' AND date <= ? ORDER BY date DESC, created_at DESC LIMIT 1").bind(today).first();
  let theme = null, health = [];
  try { theme = await d.currentTheme(env); } catch (e) { /* optional */ }
  try { health = await d.healthStrip(env); } catch (e) { /* optional */ }
  return {
    today, now: new Date().toISOString(), tz,
    tasks: await decorate(env, rows),
    completions,
    areas: areas.map(a => ({ id: a.id, title: a.title, sort: a.sort })),
    projects: areas.flatMap(a => a.projects).concat(await all("SELECT * FROM projects WHERE tenant_id = 'owner' AND trashed_at IS NULL AND area_id IS NULL ORDER BY sort, title"))
      .map(p => ({ id: p.id, area_id: p.area_id, title: p.title, notes: p.notes, deadline: p.deadline, status: p.status, completed_at: p.completed_at, headings: headings.filter(h => h.project_id === p.id).map(h => ({ id: h.id, title: h.title })) })),
    events, brief: brief || null, theme, health, settings: await readSettings(env),
    timer: await runningEntry(env), time: await timeTotals(env),
  };
}

async function createTask(env, ctx, b, d) {
  if (!b || typeof b !== 'object') return json({ error: 'Invalid body' }, 400);
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 200) return json({ error: 'Invalid title' }, 400);
  if (b.notes != null && (typeof b.notes !== 'string' || b.notes.length > 10000)) return json({ error: 'Invalid notes' }, 400);
  if (b.source !== undefined) return json({ error: 'source is set by the agent API only' }, 400);
  const v = validateV1(b);
  if (v.error) return json({ error: v.error }, 400);
  const f = v.fields;
  if (!('due_date' in f) && !('inbox' in f) && !('start' in f)) Object.assign(f, { inbox: 1, due_date: null }); // nothing chosen -> Inbox
  if (f.recurrence && !f.due_date) Object.assign(f, { due_date: d.getTodayLA(), inbox: 0, start: null }); // a repeat needs a date: starts today
  const c = await syncCompat(env, f, b, null);
  if (c.error) return json({ error: c.error }, 400);
  const id = 't-' + d.generateId().slice(0, 8);
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, notes, area, inbox, created_via, created_at, updated_at) VALUES (?, \'owner\', \'Tasks\', ?, ?, ?, ?, ?, ?, ?, \'app\', ?, ?)')
    .bind(id, title, f.priority || 'P2', f.due_date ?? null, f.recurrence ?? null, b.notes && b.notes.trim() ? b.notes : null, f.area ?? null, f.inbox ?? 0, now, now).run();
  const cols = Object.keys(f).filter(k => !['due_date', 'area', 'inbox', 'priority', 'recurrence'].includes(k));
  const stmts = [];
  if (cols.length) stmts.push(env.DB.prepare(`UPDATE tasks SET ${cols.map(k => k + ' = ?').join(', ')} WHERE id = ?`).bind(...cols.map(k => f[k]), id));
  stmts.push(...extrasStmts(env, id, v.extras));
  if (stmts.length) await env.DB.batch(stmts);
  const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  const [out] = await decorate(env, [row]);
  d.emit(env, ctx, 'task_created', { task_id: id, area: row.area, props: { via: 'v1', start: out.start, evening: out.evening, project: !!row.project_id } });
  return json(out, 201);
}

// PATCH body: any v1/v0 field, plus completed / canceled / trashed (booleans) as status changes
async function updateTask(env, ctx, id, b, d) {
  if (!b || typeof b !== 'object') return json({ error: 'Invalid body' }, 400);
  const { completed, canceled, trashed, ...rest } = b;
  for (const [k, v] of Object.entries({ completed, canceled, trashed })) if (v !== undefined && typeof v !== 'boolean') return json({ error: `${k} must be boolean` }, 400);
  const task = await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = 'owner' AND id = ?").bind(id).first();
  if (!task) return json({ error: 'Task not found' }, 404);
  if (Object.keys(rest).length) {
    const r = await d.patchTask(env, ctx, id, rest, 'v1');
    if (r.status !== 200) return r;
  }
  if (trashed !== undefined && !!task.trashed_at !== trashed) {
    await env.DB.prepare('UPDATE tasks SET trashed_at = ?, updated_at = ? WHERE id = ?').bind(trashed ? new Date().toISOString() : null, new Date().toISOString(), id).run();
    d.emit(env, ctx, trashed ? 'task_trashed' : 'task_untrashed', { task_id: id, area: task.area, props: { via: 'v1' } });
  }
  if (completed === true || canceled === true || trashed === true) await stopTimer(env, ctx, d, 'v1', id);
  if (completed === true) await d.completeTask(env, ctx, id, 'v1');
  else if (completed === false) await d.uncompleteTask(env, ctx, id, 'v1');
  if (canceled === true) {
    // A repeating to-do cancels this occurrence (moves to the next); a one-off goes to the Logbook as canceled
    const r = await d.dropTask(env, ctx, id, { series: task.recurrence ? 'skip' : undefined }, 'v1');
    if (r.error && r.status !== 409) return json({ error: r.error }, r.status || 400);
  } else if (canceled === false && task.dropped_at) {
    await d.restoreTask(env, ctx, id, {}, 'v1');
  }
  const row = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first();
  return json((await decorate(env, [row]))[0]);
}

async function feedback(env, ctx, b, d) {
  if (!b || typeof b !== 'object') return json({ error: 'Invalid body' }, 400);
  const s = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);
  const note = s(b.note, 4000), screen = s(b.screen, 80);
  let shot = null;
  if (b.screenshot != null) {
    if (typeof b.screenshot !== 'string' || !/^data:image\/(jpeg|png);base64,/.test(b.screenshot) || b.screenshot.length > 800000) return json({ error: 'screenshot must be a JPEG/PNG data URL up to ~600 KB' }, 400);
    shot = b.screenshot;
  }
  if (!note && !shot) return json({ error: 'note or screenshot required' }, 400);
  const id = 'f-' + d.generateId().slice(0, 10);
  await env.DB.prepare("INSERT INTO feedback (id, tenant_id, created_at, note, screen, app_version, device, screenshot) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?)")
    .bind(id, new Date().toISOString(), note, screen, s(b.app_version, 40), s(b.device, 120), shot).run();
  d.emit(env, ctx, 'feedback_sent', { props: { screen, has_screenshot: !!shot } });
  return json({ id }, 201);
}

// ---- settings shared across devices (migration 0013) ----
const SETTINGS = {
  work_start: (v) => Number.isInteger(v) && v >= 0 && v <= 1440, work_end: (v) => Number.isInteger(v) && v >= 0 && v <= 1440,
  free_lines: (v) => typeof v === 'boolean', work_fold: (v) => typeof v === 'boolean', show_place: (v) => typeof v === 'boolean', suggestions: (v) => typeof v === 'boolean',
  // "Claude check-ins": how often the CoS polls /api/agent/wake (platform minimum 60 min)
  checkins: (v) => v && typeof v === 'object' && Number.isInteger(v.every_minutes) && v.every_minutes >= 60 && v.every_minutes <= 1440
    && [v.start, v.end].every(t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)) && v.start < v.end && Object.keys(v).length === 3,
  cals: (v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= 10 && Object.entries(v).every(([k, x]) => /^[a-z]{1,20}$/.test(k) && typeof x === 'boolean'),
};
export const SETTINGS_DEFAULTS = { work_start: 480, work_end: 1065, free_lines: true, work_fold: true, show_place: false, suggestions: true, cals: { family: true, personal: true, work: true },
  checkins: { every_minutes: 60, start: '07:00', end: '22:00' } };
export async function readSettings(env) {
  const rows = (await env.DB.prepare("SELECT key, value FROM settings WHERE tenant_id = 'owner'").all()).results || [];
  const out = { ...SETTINGS_DEFAULTS };
  for (const r of rows) if (r.key in SETTINGS) { try { out[r.key] = JSON.parse(r.value); } catch (e) { /* keep default */ } }
  return out;
}
async function writeSettings(env, ctx, b, d) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return json({ error: 'Invalid body' }, 400);
  const keys = Object.keys(b);
  if (!keys.length) return json({ error: 'No settings' }, 400);
  for (const k of keys) if (!(k in SETTINGS) || !SETTINGS[k](b[k])) return json({ error: `Invalid setting ${k}` }, 400);
  const cur = await readSettings(env);
  const next = { ...cur, ...b };
  if (next.work_end <= next.work_start) return json({ error: 'work_end must be after work_start' }, 400);
  const now = new Date().toISOString();
  await env.DB.batch(keys.map(k => env.DB.prepare("INSERT INTO settings (tenant_id, key, value, updated_at) VALUES ('owner', ?, ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(k, JSON.stringify(b[k]), now)));
  d.emit(env, ctx, 'settings_changed', { props: { keys, via: 'v1' } });
  return json(next);
}

// ---- timer (time_entries): one running at a time; stop on complete/cancel/delete ----
const TIMER_MAX_S = 12 * 3600; // an entry left running longer is capped (forgotten timer)
async function runningEntry(env) {
  return env.DB.prepare("SELECT e.*, t.title FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.tenant_id = 'owner' AND e.stopped_at IS NULL ORDER BY e.started_at DESC LIMIT 1").first();
}
export async function stopTimer(env, ctx, d, via, taskId) {
  const run = await runningEntry(env);
  if (!run || (taskId && run.task_id !== taskId)) return null;
  const now = new Date(), secs = Math.min(TIMER_MAX_S, Math.max(0, Math.round((now - Date.parse(run.started_at)) / 1000)));
  await env.DB.prepare('UPDATE time_entries SET stopped_at = ?, seconds = ? WHERE id = ?').bind(now.toISOString(), secs, run.id).run();
  d.emit(env, ctx, 'timer_stopped', { task_id: run.task_id, props: { seconds: secs, via } });
  return { ...run, stopped_at: now.toISOString(), seconds: secs };
}
async function timer(env, ctx, b, d) {
  if (!b || !['start', 'stop'].includes(b.action)) return json({ error: "action must be 'start' or 'stop'" }, 400);
  if (b.action === 'stop') return json({ stopped: await stopTimer(env, ctx, d, 'v1'), running: null });
  const task = await env.DB.prepare("SELECT id, title FROM tasks WHERE tenant_id = 'owner' AND id = ? AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL").bind(b.task_id || '').first();
  if (!task) return json({ error: 'Task not found or not open' }, 404);
  const stopped = await stopTimer(env, ctx, d, 'v1');
  const id = 'te-' + d.generateId().slice(0, 10), now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO time_entries (id, tenant_id, task_id, started_at) VALUES (?, 'owner', ?, ?)").bind(id, task.id, now).run();
  d.emit(env, ctx, 'timer_started', { task_id: task.id, props: { via: 'v1' } });
  return json({ stopped, running: { id, task_id: task.id, title: task.title, started_at: now } });
}
async function timeTotals(env) {
  const rows = (await env.DB.prepare("SELECT task_id, SUM(seconds) AS seconds FROM time_entries WHERE tenant_id = 'owner' AND seconds IS NOT NULL GROUP BY task_id").all()).results || [];
  return Object.fromEntries(rows.map(r => [r.task_id, r.seconds]));
}
// Agent read (COS-NEEDS §2): entries since T (with task title, deadline/start for estimate-vs-actual) and the running one
export async function agentTime(env, url) {
  const sp = url.searchParams.get('since');
  if (sp && isNaN(Date.parse(sp))) return json({ error: 'Invalid since' }, 400);
  const since = sp ? new Date(sp).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = (await env.DB.prepare(`SELECT e.id, e.task_id, e.started_at, e.stopped_at, e.seconds, t.title, t.area_id, t.project_id, t.completed_at
      FROM time_entries e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.tenant_id = 'owner' AND e.started_at >= ? ORDER BY e.started_at`).bind(since).all()).results || [];
  const run = await runningEntry(env);
  const by = {};
  for (const r of rows) if (r.seconds != null) { const x = by[r.task_id] || (by[r.task_id] = { task_id: r.task_id, title: r.title, seconds: 0, entries: 0 }); x.seconds += r.seconds; x.entries++; }
  return json({ since, running: run ? { task_id: run.task_id, title: run.title, started_at: run.started_at, seconds_so_far: Math.round((Date.now() - Date.parse(run.started_at)) / 1000) } : null,
    by_task: Object.values(by).sort((a, b) => b.seconds - a.seconds), entries: rows });
}

// ---- change-driven wake, pull mode (BUILD-v1 (f) without a relay): the CoS polls GET /api/agent/wake on its schedule and
// runs when flag is true, then POSTs /api/agent/wake/ack. Code-only check, ids and short titles only (no message bodies).
const WAKE_CAP = 8; // flagged wakes acked per local day
export async function wake(env, url) {
  const set = await readSettings(env), tz = calendarConfig(env).tz;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]));
  const hhmm = `${parts.hour}:${parts.minute}`, localDay = `${parts.year}-${parts.month}-${parts.day}`;
  const quiet = hhmm < set.checkins.start || hhmm >= set.checkins.end;
  const ack = await env.DB.prepare("SELECT value FROM settings WHERE tenant_id = 'owner' AND key = 'wake_ack'").first();
  const since = ack ? JSON.parse(ack.value) : new Date(Date.now() - 86400000).toISOString();
  const all = async (sql, ...b) => (await env.DB.prepare(sql).bind(...b).all()).results || [];
  const clip = (v) => (v == null ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, 80));
  const changes = [];
  // mail: new inbound Primary mail, archived or not (archiving is not handling it), plus inbox mail marked Important in
  // other tabs. Automated and mailing-list senders count too
  // (school, activity and account notices come that way) but are marked bulk: true. Never the owner's own (SENT label,
  // OWN_ADDRESSES), future-dated (scheduled sends), spam or trash.
  const own = String(env.OWN_ADDRESSES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  for (const m of (await all(`SELECT msg_id, thread_id, subject, from_name, from_addr, ts, (COALESCE(list_unsubscribe, 0) = 1 OR ${AUTOMATED_SQL}) AS bulk FROM mail_messages
      WHERE tenant_id = 'owner' AND direction = 'in' AND deleted_at IS NULL AND COALESCE(is_trashed, 0) = 0 AND COALESCE(is_spam, 0) = 0
      AND (COALESCE(category, 'primary') = 'primary' OR (labels LIKE '%"IMPORTANT"%' AND labels LIKE '%"INBOX"%'))
      AND COALESCE(labels, '') NOT LIKE '%"SENT"%' AND COALESCE(labels, '') NOT LIKE '%"SPAM"%' AND COALESCE(labels, '') NOT LIKE '%"TRASH"%' AND ts > ? AND ts <= ? ORDER BY ts LIMIT 50`, since, new Date().toISOString())).filter(m => !own.includes(String(m.from_addr || '').toLowerCase())))
    changes.push({ kind: 'mail', id: m.msg_id, thread_id: m.thread_id, title: clip(m.subject), from: clip(m.from_name || m.from_addr), at: m.ts, bulk: !!m.bulk });
  // calendar: added / changed / cancelled events starting within the next 48 h
  const soon = new Date(Date.now() + 48 * 3600000).toISOString(), now = new Date().toISOString();
  for (const c of await all("SELECT * FROM calendar_changes WHERE tenant_id = 'owner' AND at > ? ORDER BY at LIMIT 200", since)) {
    let b = null, a = null; try { b = c.before ? JSON.parse(c.before) : null; a = c.after ? JSON.parse(c.after) : null; } catch (e) { /* skip */ }
    const starts = [a && a.start_ts, b && b.start_ts].filter(Boolean);
    if (!starts.some(t => t >= now && t <= soon)) continue;
    changes.push({ kind: 'calendar', change: c.kind, id: c.event_id, title: clip((a || b || {}).title), start: (a || b).start_ts, at: c.at });
  }
  // chats: new inbound messages from the short VIP list (Worker secret WAKE_VIP, comma-separated names or chat ids)
  const vip = String(env.WAKE_VIP || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (vip.length) {
    for (const r of await all(`SELECT id, title, ts, json_extract(meta, '$.chat_id') AS chat_id, json_extract(meta, '$.sender') AS sender FROM items WHERE tenant_id = 'owner' AND removed_at IS NULL AND ts > ?
        AND json_extract(meta, '$.chat_id') IS NOT NULL AND json_extract(meta, '$.direction') = 'in' ORDER BY ts LIMIT 200`, since)) {
      const keys = [r.chat_id, r.sender, r.title].filter(Boolean).map(x => String(x).toLowerCase());
      if (keys.some(k => vip.some(v => k === v || k.includes(v)))) changes.push({ kind: 'chat', id: r.chat_id, title: clip(r.sender || r.title), at: r.ts });
    }
  }
  // cap: wakes acked today with changes (local day); quiet hours: outside the check-in window
  const acked = (await env.DB.prepare("SELECT at FROM wake_log WHERE status = 'ack' AND kinds IS NOT NULL AND at >= ?").bind(new Date(Date.now() - 36 * 3600000).toISOString()).all()).results || [];
  const today = acked.filter(r => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(r.at)) === localDay).length;
  const capped = today >= WAKE_CAP;
  return json({ flag: changes.length > 0 && !quiet && !capped, since, changes, quiet, capped, wakes_today: today, cap: WAKE_CAP, schedule: set.checkins });
}
export async function wakeAck(env, request) {
  let b = {}; try { b = await request.json(); } catch (e) { b = {}; }
  if (b && b.at !== undefined && (typeof b.at !== 'string' || isNaN(Date.parse(b.at)))) return json({ error: 'at must be an ISO time' }, 400);
  const at = b && b.at ? new Date(b.at).toISOString() : new Date().toISOString();
  // log what this ack covers (kinds/ids) so the daily cap counts only real wakes
  const pending = await (await wake(env, new URL('https://x/'))).json();
  const kinds = pending.changes.length ? [...new Set(pending.changes.map(c => c.kind))].join(',') : null;
  const ids = pending.changes.length ? pending.changes.map(c => c.id).slice(0, 50).join(',') : null;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (tenant_id, key, value, updated_at) VALUES ('owner', 'wake_ack', ?, ?) ON CONFLICT(tenant_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(JSON.stringify(at), new Date().toISOString()),
    env.DB.prepare("INSERT INTO wake_log (id, at, kinds, ids, status) VALUES (?, ?, ?, ?, 'ack')").bind('w-' + crypto.randomUUID().slice(0, 12), new Date().toISOString(), kinds, ids),
  ]);
  return json({ ok: true, acked_through: at });
}

// ---- event labels: titles for free/busy blocks (the CoS reads them off a calendar screenshot) ----
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function labelFields(b) {
  if (!b || typeof b !== 'object') return { error: 'Invalid label' };
  if (b.start === undefined && b.approx_start !== undefined) b = { ...b, start: b.approx_start };
  if (b.end === undefined && b.approx_end !== undefined) b = { ...b, end: b.approx_end };
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 120) return { error: 'title required (max 120)' };
  if (!HHMM.test(b.start || '')) return { error: 'start must be HH:MM' };
  if (b.end != null && !HHMM.test(b.end)) return { error: 'end must be HH:MM' };
  const recurring = b.recurring === true;
  let date = null, weekday = null;
  if (recurring) {
    weekday = b.weekday;
    if (weekday === undefined && b.date) weekday = new Date(b.date + 'T00:00:00Z').getUTCDay();
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) return { error: 'a recurring label needs weekday 0-6 (Sun-Sat)' };
  } else {
    date = b.date;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return { error: 'a one-off label needs date YYYY-MM-DD (or recurring: true + weekday)' };
  }
  return { f: { date, weekday, start: b.start, end: b.end ?? null, title, recurring: recurring ? 1 : 0 } };
}
export async function eventLabels(env, ctx, request, url, path, d) {
  const method = request.method;
  if (path === '/api/agent/event-labels' && method === 'GET') {
    const rows = (await env.DB.prepare("SELECT * FROM event_labels WHERE tenant_id = 'owner' ORDER BY recurring DESC, weekday, date, start").all()).results || [];
    return json({ count: rows.length, labels: rows.map(r => ({ ...r, recurring: !!r.recurring })) });
  }
  if (path === '/api/agent/event-labels' && method === 'POST') {
    let b; try { b = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
    const list = Array.isArray(b) ? b : Array.isArray(b && b.labels) ? b.labels : [b];
    if (!list.length || list.length > 100) return json({ error: '1-100 labels' }, 400);
    const rows = [];
    for (const [i, x] of list.entries()) { const v = labelFields(x); if (v.error) return json({ error: `label ${i}: ${v.error}` }, 400); rows.push(v.f); }
    const now = new Date().toISOString(), out = [];
    const stmts = rows.map(f => { const id = 'el-' + d.generateId().slice(0, 10); out.push({ id, ...f, recurring: !!f.recurring });
      // one label per slot: a new label replaces an existing one for the same date/weekday + start
      return [env.DB.prepare(`DELETE FROM event_labels WHERE tenant_id = 'owner' AND start = ? AND recurring = ? AND ${f.recurring ? 'weekday = ?' : 'date = ?'}`).bind(f.start, f.recurring, f.recurring ? f.weekday : f.date),
        env.DB.prepare('INSERT INTO event_labels (id, tenant_id, date, weekday, start, "end", title, recurring, created_via, created_at) VALUES (?, \'owner\', ?, ?, ?, ?, ?, ?, \'agent\', ?)')
          .bind(id, f.date, f.weekday, f.start, f.end, f.title, f.recurring, now)]; }).flat();
    await env.DB.batch(stmts);
    d.emit(env, ctx, 'event_labels_set', { props: { n: rows.length } });
    return json({ count: out.length, labels: out }, 201);
  }
  const m = path.match(/^\/api\/agent\/event-labels\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'DELETE') {
    const r = await env.DB.prepare("DELETE FROM event_labels WHERE tenant_id = 'owner' AND id = ?").bind(m[1]).run();
    if (!r.meta || !r.meta.changes) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }
  return json({ error: 'Not found' }, 404);
}
// Free/busy blocks merge back-to-back holds and meetings (e.g. 06:00-11:00 for a 10:30 meeting), so a labeled meeting is
// shown at the LABEL's time, clipped to the block: label.start to label.end (no end: 30 min, or the next label's start
// if sooner). Label times are approximate (read off a screenshot): a label matches a block when its start falls inside
// it, allowing 15 minutes early. One-off labels for the date win over recurring ones for the weekday. The rest of the
// block stays "Busy", except a part that sits under the person's own named events (they already show by name) or is
// under 5 minutes.
const LABEL_SLACK_MIN = 15, LABEL_DEFAULT_MIN = 30, BUSY_MIN_MIN = 5;
export function splitLabeled(labels, events, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' });
  const parts = (iso) => Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  const own = events.filter(e => !e.busy && !e.all_day).map(e => [Date.parse(e.start), Date.parse(e.end)]);
  // minus(span, covers): the pieces of [a, z) not covered by any of covers
  const minus = (a, z, covers) => { let out = [[a, z]];
    for (const [ca, cz] of covers) out = out.flatMap(([x, y]) => cz <= x || ca >= y ? [[x, y]] : [[x, Math.max(x, ca)], [Math.min(y, cz), y]].filter(([p, q]) => q > p));
    return out; };
  const iso = (ms) => new Date(ms).toISOString();
  const out = [];
  for (const ev of events) {
    if (!ev.busy || ev.all_day) { out.push(ev); continue; }
    const s = parts(ev.start), e = parts(ev.end), S = Date.parse(ev.start), Z = Date.parse(ev.end);
    const date = `${s.year}-${s.month}-${s.day}`, wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(s.weekday);
    const min = (hhmm) => { const [h, m] = hhmm.split(':'); return +h * 60 + +m; }, bs = min(`${s.hour}:${s.minute}`);
    let be = min(`${e.hour}:${e.minute}`); if (`${e.year}-${e.month}-${e.day}` !== date || be <= bs) be = 24 * 60;
    const hits = (l) => { const t = min(l.start); return t >= bs - LABEL_SLACK_MIN && t < be; };
    const byStart = (x, y) => x.start.localeCompare(y.start);
    let ms = labels.filter(l => !l.recurring && l.date === date && hits(l)).sort(byStart);
    if (!ms.length) ms = labels.filter(l => l.recurring && l.weekday === wd && hits(l)).sort(byStart);
    if (!ms.length) { out.push(ev); continue; }
    const at = (hhmm) => S + (min(hhmm) - bs) * 60000; // local HH:MM on the block's day -> ms
    const spans = ms.map((l, i) => {
      const a = Math.max(S, at(l.start)), next = ms[i + 1] ? at(ms[i + 1].start) : Infinity;
      let z = l.end && min(l.end) > min(l.start) ? at(l.end) : Math.min(a + LABEL_DEFAULT_MIN * 60000, next > a ? next : Infinity);
      return { a, z: Math.min(z, Z), title: l.title };
    }).filter(x => x.z > x.a);
    for (const x of spans) out.push({ ...ev, id: `${ev.id}#${iso(x.a)}`, start: iso(x.a), end: iso(x.z), title: x.title, labeled: true });
    for (const [a, z] of minus(S, Z, spans.map(x => [x.a, x.z]))) {
      if (z - a < BUSY_MIN_MIN * 60000 || !minus(a, z, own).length) continue;
      out.push({ ...ev, id: a === S ? ev.id : `${ev.id}#${iso(a)}`, start: iso(a), end: iso(z) });
    }
  }
  return out.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));
}

// ---- device tokens (the Android shell's widget, timer notification and shake-to-report) ----
// Paired from the signed-in app (cookie); the token is shown once and only its SHA-256 is stored. A device token works
// ONLY on: GET /api/v1/widget/today, POST /api/v1/timer {action:'stop'}, POST /api/v1/feedback and
// PATCH /api/v1/tasks/:id {completed: true|false} (the widget's checkbox) and POST /api/v1/tasks {title, client_id}
// (the add-task widget). Revoking is soft.
const DEVICE_SCOPES = 'widget,timer_stop,feedback,complete,create';
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
async function pairDevice(env, ctx, b, d) {
  const label = (b && typeof b.label === 'string' && b.label.trim() ? b.label.trim() : 'Android').slice(0, 60);
  const token = 'dv_' + [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
  const id = 'dev-' + d.generateId().slice(0, 10), now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO device_tokens (id, tenant_id, label, token_hash, scopes, created_at) VALUES (?, 'owner', ?, ?, ?, ?)").bind(id, label, await sha256(token), DEVICE_SCOPES, now).run();
  d.emit(env, ctx, 'device_paired', { props: { label } });
  return json({ id, token, label, scopes: DEVICE_SCOPES.split(','), created_at: now }, 201);
}
async function listDevices(env) {
  const rows = (await env.DB.prepare("SELECT id, label, scopes, created_at, last_used_at FROM device_tokens WHERE tenant_id = 'owner' AND revoked_at IS NULL ORDER BY created_at DESC").all()).results || [];
  return json({ devices: rows.map(r => ({ ...r, scopes: String(r.scopes).split(',') })) });
}
async function revokeDevice(env, ctx, id, d) {
  const r = await env.DB.prepare("UPDATE device_tokens SET revoked_at = ? WHERE tenant_id = 'owner' AND id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), id).run();
  if (!r.meta || !r.meta.changes) return json({ error: 'Not found' }, 404);
  d.emit(env, ctx, 'device_revoked', { props: {} });
  return json({ ok: true });
}
// Widget: Today in brief, titles only (no notes)
async function widgetToday(env, d) {
  const today = d.getTodayLA();
  const rows = (await env.DB.prepare(`SELECT id, title, flagged, deadline, evening, due_date FROM tasks WHERE tenant_id = 'owner' AND parent_task_id IS NULL
      AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL AND COALESCE(suggestion_state, 'accepted') = 'accepted' AND COALESCE(list, 'Tasks') != 'Claude'
      AND ((due_date IS NOT NULL AND due_date <= ?) OR (deadline IS NOT NULL AND deadline <= ? AND COALESCE(start, '') != 'someday'))
    ORDER BY evening, COALESCE(today_index, 1e9), due_date LIMIT 50`).bind(today, today).all()).results || [];
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const items = rows.map(r => ({ id: r.id, title: r.title, flagged: !!r.flagged, evening: !!r.evening,
    deadline_text: r.deadline ? (r.deadline < today ? `${days(r.deadline, today)} days overdue` : r.deadline === today ? 'Due today' : null) : null }));
  const tz = calendarConfig(env).tz, start = zonedMidnight(today, tz), end = new Date(Date.parse(start) + 86400000).toISOString(), now = new Date().toISOString();
  let evs = ((await env.DB.prepare("SELECT calendar_id, event_id, title, start_ts, end_ts, all_day, status FROM calendar_events WHERE tenant_id = 'owner' AND removed_at IS NULL AND end_ts > ? AND start_ts < ? ORDER BY start_ts").bind(now, end).all()).results || [])
    .map(r => ({ id: r.calendar_id + '|' + r.event_id, start: r.start_ts, end: r.end_ts, all_day: !!r.all_day, title: r.title, busy: r.status === 'busy' }));
  const labels = (await env.DB.prepare("SELECT * FROM event_labels WHERE tenant_id = 'owner'").all()).results || [];
  // same rows as the Today view: a merged busy block shows its labeled meetings at their own times
  if (labels.length) evs = splitLabeled(labels, evs, tz).filter(e => e.end > now);
  const next = evs.find(e => !e.all_day);
  return json({ date: today, count: items.length, items, events_left: evs.length, next_event: next ? { title: next.labeled || !next.busy ? next.title : 'Busy', start: next.start } : null });
}
export async function deviceRequest(request, env, ctx, url, path, d) {
  const auth = request.headers.get('authorization') || '';
  if (!/^Bearer dv_[0-9a-f]{64}$/.test(auth)) return null; // not a device call: the app's cookie rules apply
  const allowed = (path === '/api/v1/widget/today' && request.method === 'GET') || (path === '/api/v1/timer' && request.method === 'POST') || (path === '/api/v1/feedback' && request.method === 'POST')
    || (/^\/api\/v1\/tasks\/[A-Za-z0-9_-]+$/.test(path) && request.method === 'PATCH')
    || (path === '/api/v1/tasks' && request.method === 'POST');
  if (!allowed) return json({ error: 'Forbidden for device tokens' }, 403);
  const row = await env.DB.prepare("SELECT id FROM device_tokens WHERE tenant_id = 'owner' AND token_hash = ? AND revoked_at IS NULL").bind(await sha256(auth.slice(7))).first();
  if (!row) return json({ error: 'Unauthorized' }, 401);
  ctx.waitUntil(env.DB.prepare('UPDATE device_tokens SET last_used_at = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run().catch(() => {}));
  try {
    if (path === '/api/v1/widget/today') return await widgetToday(env, d);
    if (path === '/api/v1/timer') {
      let b; try { b = await request.json(); } catch (e) { b = null; }
      if (!b || b.action !== 'stop') return json({ error: "Device tokens can only stop the timer ({action:'stop'})" }, 403);
      return json({ stopped: await stopTimer(env, ctx, d, 'device'), running: null });
    }
    let b; try { b = await request.json(); } catch (e) { b = undefined; }
    if (path === '/api/v1/tasks') return await deviceCreate(env, ctx, b, d);
    if (path.startsWith('/api/v1/tasks/')) return await deviceComplete(env, ctx, path.slice('/api/v1/tasks/'.length), b, d);
    return await feedback(env, ctx, b, d);
  } catch (e) { console.error('device api error', String(e)); return json({ error: 'Internal error' }, 500); }
}

// The widget's checkbox: {completed: true} completes (a repeating to-do moves to its next date, a running timer on it
// stops), {completed: false} undoes. Nothing else. Logged with via 'device'.
async function deviceComplete(env, ctx, id, b, d) {
  if (!b || typeof b !== 'object' || Object.keys(b).length !== 1 || typeof b.completed !== 'boolean')
    return json({ error: 'Device tokens can only send {completed: true|false}' }, 403);
  const task = await env.DB.prepare("SELECT id, completed_at, dropped_at, trashed_at FROM tasks WHERE tenant_id = 'owner' AND id = ? AND parent_task_id IS NULL").bind(id).first();
  if (!task || task.trashed_at) return json({ error: 'Task not found' }, 404);
  if (b.completed) { await stopTimer(env, ctx, d, 'device', id); await d.completeTask(env, ctx, id, 'device'); }
  else await d.uncompleteTask(env, ctx, id, 'device');
  const row = await env.DB.prepare("SELECT id, title, due_date, completed_at, recurrence FROM tasks WHERE id = ?").bind(id).first();
  return json({ id: row.id, title: row.title, completed: !!row.completed_at, due_date: row.due_date, repeating: !!row.recurrence });
}

// The add-task widget: {title, client_id} only -> an Inbox to-do. The phone queues offline and retries, so the id is
// derived from client_id: a retry finds the same to-do and gets it back (200) instead of a duplicate.
async function deviceCreate(env, ctx, b, d) {
  const keys = b && typeof b === 'object' ? Object.keys(b).sort().join(',') : '';
  if (keys !== 'client_id,title') return json({ error: 'Device tokens can only send {title, client_id}' }, 403);
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (!title || title.length > 200) return json({ error: 'Invalid title' }, 400);
  if (typeof b.client_id !== 'string' || !b.client_id || b.client_id.length > 64) return json({ error: 'Invalid client_id' }, 400);
  const id = 't-dv' + (await sha256('client:' + b.client_id)).slice(0, 16), now = new Date().toISOString();
  const r = await env.DB.prepare("INSERT OR IGNORE INTO tasks (id, tenant_id, list, title, priority, due_date, inbox, created_via, created_at, updated_at) VALUES (?, 'owner', 'Tasks', ?, 'P2', NULL, 1, 'android', ?, ?)")
    .bind(id, title, now, now).run();
  const row = await env.DB.prepare("SELECT id, title FROM tasks WHERE id = ?").bind(id).first();
  if (!r.meta || !r.meta.changes) return json({ id: row.id, title: row.title }, 200);
  d.emit(env, ctx, 'task_created', { task_id: id, props: { via: 'device', start: 'inbox' } });
  return json({ id: row.id, title: row.title }, 201);
}

// Agent read side of feedback (BUILD-v1 (g)): list without screenshots; one screenshot by id
export async function agentFeedback(env, url, path) {
  const m = path.match(/^\/api\/agent\/feedback\/([A-Za-z0-9_-]+)\/screenshot$/);
  if (m) {
    const r = await env.DB.prepare("SELECT screenshot FROM feedback WHERE tenant_id = 'owner' AND id = ?").bind(m[1]).first();
    if (!r || !r.screenshot) return json({ error: 'Not found' }, 404);
    return json({ id: m[1], screenshot: r.screenshot });
  }
  const since = url.searchParams.get('since');
  if (since && isNaN(Date.parse(since))) return json({ error: 'Invalid since' }, 400);
  const rows = (await env.DB.prepare("SELECT id, created_at, note, screen, app_version, device, screenshot IS NOT NULL AS has_screenshot FROM feedback WHERE tenant_id = 'owner' AND created_at >= ? ORDER BY created_at DESC LIMIT 200")
    .bind(since ? new Date(since).toISOString() : '1970').all()).results || [];
  return json({ count: rows.length, feedback: rows.map(r => ({ ...r, has_screenshot: !!r.has_screenshot })) });
}

// Anomaly feed for the CoS (COS-NEEDS §2): cancels, deletes, reschedules, to-dos postponed 3+ times, completions after
// the deadline. Read-only; built from the events log, so v0 and v1 actions both count.
// GET /api/agent/anomalies?since=ISO (default 7 days)&late_days=N (default 1)
export async function anomalies(env, url) {
  const sp = url.searchParams.get('since');
  if (sp && isNaN(Date.parse(sp))) return json({ error: 'Invalid since' }, 400);
  const since = sp ? new Date(sp).toISOString() : new Date(Date.now() - 7 * 86400000).toISOString();
  const lateDays = url.searchParams.has('late_days') ? parseInt(url.searchParams.get('late_days'), 10) : 1;
  if (!(lateDays >= 0)) return json({ error: 'Invalid late_days' }, 400);
  const tz = calendarConfig(env).tz;
  const local = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(iso));
  const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  // postponement counts look back at least 30 days so "moved 3+ times" isn't cut off by a short window
  const lookback = new Date(Math.min(Date.parse(since), Date.now() - 30 * 86400000)).toISOString();
  const rows = (await env.DB.prepare(`SELECT e.kind, e.at, e.task_id, e.props, t.title, t.deadline, t.recurrence, t.dropped_at, t.trashed_at, t.completed_at
      FROM events e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.tenant_id = 'owner' AND e.at >= ? AND e.task_id IS NOT NULL
        AND e.kind IN ('task_dropped', 'task_skipped', 'task_trashed', 'task_snoozed', 'task_edited', 'task_completed')
      ORDER BY e.at`).bind(lookback).all()).results || [];
  const P = (r) => { try { return r.props ? JSON.parse(r.props) : {}; } catch (e) { return {}; } };
  const base = (r, p) => ({ task_id: r.task_id, title: r.title || null, at: r.at, via: p.via || null });
  const cancels = [], deletes = [], reschedules = [], late = [], moves = new Map();
  for (const r of rows) {
    const p = P(r), inWindow = r.at >= since;
    let move = null;
    if (r.kind === 'task_snoozed' || (r.kind === 'task_edited' && p.rescheduled)) move = { from: p.from ?? null, to: p.to ?? null };
    // (moving to Someday/backlog also logs task_backlogged next to task_edited; task_edited is the one counted)
    if (move) {
      const postponed = move.to === null || (move.from && move.to > move.from);
      if (postponed) (moves.get(r.task_id) || moves.set(r.task_id, { title: r.title, n: 0, last: null, history: [] }).get(r.task_id)).n++;
      if (postponed) { const m = moves.get(r.task_id); m.last = r.at; m.history.push({ at: r.at, ...move }); }
      if (inWindow) reschedules.push({ ...base(r, p), ...move, postponed });
      continue;
    }
    if (!inWindow) continue;
    if (r.kind === 'task_dropped') cancels.push({ ...base(r, p), kind: 'canceled', still_canceled: !!r.dropped_at, reason: p.reason || null });
    else if (r.kind === 'task_skipped') cancels.push({ ...base(r, p), kind: 'skipped', occurrence: p.occurrence || p.from || null });
    else if (r.kind === 'task_trashed') deletes.push({ ...base(r, p), still_deleted: !!r.trashed_at });
    else if (r.kind === 'task_completed' && r.deadline) {
      const d = days(r.deadline, local(r.at));
      if (d >= lateDays) late.push({ ...base(r, p), deadline: r.deadline, completed_on: local(r.at), days_late: d });
    }
  }
  const postponed = [...moves.entries()].filter(([, m]) => m.n >= 3 && m.last >= since)
    .map(([task_id, m]) => ({ task_id, title: m.title || null, times: m.n, last_at: m.last, history: m.history.slice(-6) }))
    .sort((a, b) => b.times - a.times);
  return json({ since, counts: { cancels: cancels.length, deletes: deletes.length, reschedules: reschedules.length, postponed_3x: postponed.length, late_completions: late.length },
    cancels, deletes, reschedules, postponed_3x: postponed, late_completions: late });
}

// Projects/areas from the app reuse the agent structure handler (same validation), re-pathed
export async function handleV1App(request, env, ctx, url, path, d, handleStructure) {
  const method = request.method;
  const body = async () => { try { return await request.json(); } catch (e) { return undefined; } };
  try {
    if (path === '/api/v1/state' && method === 'GET') return json(await state(env, d));
    if (path === '/api/v1/tasks' && method === 'POST') return await createTask(env, ctx, await body(), d);
    const m = path.match(/^\/api\/v1\/tasks\/([A-Za-z0-9_-]+)$/);
    if (m && method === 'PATCH') return await updateTask(env, ctx, m[1], await body(), d);
    if (path === '/api/v1/feedback' && method === 'POST') return await feedback(env, ctx, await body(), d);
    if (path === '/api/v1/devices' && method === 'POST') return await pairDevice(env, ctx, await body(), d);
    if (path === '/api/v1/devices' && method === 'GET') return await listDevices(env);
    const dv = path.match(/^\/api\/v1\/devices\/([A-Za-z0-9_-]+)$/);
    if (dv && method === 'DELETE') return await revokeDevice(env, ctx, dv[1], d);
    if (path === '/api/v1/widget/today' && method === 'GET') return await widgetToday(env, d);
    if (path === '/api/v1/timer' && method === 'POST') return await timer(env, ctx, await body(), d);
    if (path === '/api/v1/settings' && method === 'GET') return json(await readSettings(env));
    if (path === '/api/v1/settings' && method === 'PUT') return await writeSettings(env, ctx, await body(), d);
    if (/^\/api\/v1\/(areas|projects|headings)(\/|$)/.test(path)) {
      const agentPath = path.replace('/api/v1/', '/api/agent/');
      const r = await handleStructure(request, env, ctx, url, agentPath, method, (kind, props) => d.emit(env, ctx, kind, { props: { ...props, via: 'v1' } }));
      if (r) return r;
    }
    return json({ error: 'Not found' }, 404);
  } catch (e) {
    console.error('v1 api error', String(e));
    return json({ error: 'Internal error' }, 500);
  }
}
