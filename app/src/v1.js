// my-os v1 data model (phase 0): v1 fields on tasks, areas/projects/headings, checklist, tags, suggestions in the
// Inbox, and the v0 -> v1 migration. v0 keeps working on the same rows: compat shims keep v0 fields in sync.
// See design/BUILD-v1.md (c).

export const V1_AREAS = [
  { id: 'a-family', title: 'Family', v0: 'family' },
  { id: 'a-health', title: 'Health', v0: 'health' },
  { id: 'a-home', title: 'Home', v0: 'house' },
  { id: 'a-money', title: 'Money', v0: 'finance' },
  { id: 'a-work', title: 'Work', v0: 'work' },
  { id: 'a-people', title: 'People', v0: null },
];
const V0_TO_V1 = { kids: 'a-family', family: 'a-family', health: 'a-health', house: 'a-home', finance: 'a-money', work: 'a-work', venture: 'a-work' };
export const v1AreaForV0 = (a) => (a && V0_TO_V1[a]) || null;
export const v0AreaForV1 = (id) => (V1_AREAS.find(a => a.id === id) || {}).v0 ?? null;

const STARTS = ['inbox', 'anytime', 'someday', 'date'];
const FREQS = ['daily', 'weekly', 'monthly', 'yearly'];
const isDate = (s) => { if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false; const d = new Date(s + 'T00:00:00Z'); return !isNaN(d) && d.toISOString().slice(0, 10) === s; };
const isIso = (s) => typeof s === 'string' && !isNaN(Date.parse(s)) && /^\d{4}-\d{2}-\d{2}T/.test(s);
const newId = (p) => p + [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, '0')).join('');

// v1 "When": a date wins; otherwise Inbox / Anytime / Someday. v0 rows without `start` read as Someday when undated.
export function effectiveStart(t) {
  if (t.due_date) return 'date';
  if (t.inbox) return 'inbox';
  if (t.start === 'anytime') return 'anytime';
  return 'someday';
}

// v0 recurrence text <-> v1 repeat rule (on-schedule only; phase 4 adds the full rule engine)
export function ruleFromRecurrence(rec) {
  if (!rec) return null;
  if (rec === 'weekdays') return { mode: 'schedule', freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] };
  return { mode: 'schedule', freq: rec, interval: 1 };
}
export function recurrenceFromRule(rule) {
  if (!rule) return null;
  if (rule.freq === 'weekly' && Array.isArray(rule.byweekday) && rule.byweekday.join() === '1,2,3,4,5') return 'weekdays';
  return rule.freq; // nearest simple frequency for v0 (complex rules are v1-only)
}

function validateRule(r) {
  if (r === null) return { rule: null };
  if (!r || typeof r !== 'object') return { error: 'repeat must be an object or null' };
  const mode = r.mode || 'schedule';
  if (!['schedule', 'after'].includes(mode)) return { error: 'repeat.mode must be schedule or after' };
  if (!FREQS.includes(r.freq)) return { error: 'repeat.freq must be daily, weekly, monthly or yearly' };
  const interval = r.interval === undefined ? 1 : r.interval;
  if (!Number.isInteger(interval) || interval < 1 || interval > 365) return { error: 'repeat.interval must be 1-365' };
  const out = { mode, freq: r.freq, interval };
  if (r.byweekday !== undefined) {
    if (!Array.isArray(r.byweekday) || !r.byweekday.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) return { error: 'repeat.byweekday must be 0-6 (Sun-Sat)' };
    out.byweekday = [...new Set(r.byweekday)].sort();
  }
  if (r.bymonthday !== undefined) {
    if (!Number.isInteger(r.bymonthday) || r.bymonthday < -1 || r.bymonthday > 31 || r.bymonthday === 0) return { error: 'repeat.bymonthday must be 1-31 or -1 (last)' };
    out.bymonthday = r.bymonthday;
  }
  if (r.end !== undefined && r.end !== null) {
    const e = r.end;
    if (e.after !== undefined) { if (!Number.isInteger(e.after) || e.after < 1) return { error: 'repeat.end.after must be a positive integer' }; out.end = { after: e.after }; }
    else if (e.on !== undefined) { if (!isDate(e.on)) return { error: 'repeat.end.on must be YYYY-MM-DD' }; out.end = { on: e.on }; }
    else return { error: 'repeat.end must be {after: n} or {on: date}' };
  }
  return { rule: out };
}

// ---- repeat engine (v1). Dates are YYYY-MM-DD; all math in UTC days. ----
const DAY = 86400000;
const toN = (iso) => Math.round(Date.parse(iso + 'T00:00:00Z') / DAY);
const toIso = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const ymd = (n) => { const d = new Date(n * DAY); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()]; };
const lastDay = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const mk = (y, m, d) => Math.round(Date.UTC(y, m, Math.min(d, lastDay(y, m))) / DAY); // clamps the 31st / Feb 29
const addMonthsN = (n, k) => { const [y, m, d] = ymd(n); return mk(y, m + k, d); };

// Next on-schedule date strictly after `after`, never before `anchor` (the series' first date)
export function nextOnSchedule(rule, after, anchor) {
  const a = toN(anchor), from = Math.max(toN(after) + 1, a), n = rule.interval || 1;
  if (rule.freq === 'daily') return toIso(a + Math.ceil((from - a) / n) * n);
  if (rule.freq === 'weekly') {
    const days = rule.byweekday && rule.byweekday.length ? rule.byweekday : [((a % 7) + 11) % 7];
    const week0 = a - (((a % 7) + 11) % 7); // Sunday of the anchor week
    for (let d = from; d < from + 7 * n + 7; d++) {
      if (Math.floor((d - week0) / 7) % n === 0 && days.includes(((d % 7) + 11) % 7)) return toIso(d);
    }
    return toIso(from); // unreachable with valid rules
  }
  const [ay, am, ad] = ymd(a);
  if (rule.freq === 'monthly') {
    const want = rule.bymonthday || ad;
    const [fy, fm] = ymd(from); let k = Math.max(0, Math.floor(((fy - ay) * 12 + fm - am) / n) - 1) * n;
    for (;; k += n) { const y = ay + Math.floor((am + k) / 12), m = (am + k) % 12, d = want === -1 ? mk(y, m, 31) : mk(y, m, want); if (d >= from) return toIso(d); }
  }
  // yearly: the anchor's month and day
  const [fy] = ymd(from); let k = Math.max(0, Math.floor((fy - ay) / n) - 1) * n;
  for (;; k += n) { const d = mk(ay + k, am, ad); if (d >= from) return toIso(d); }
}
// After-completion repeats count from the day it was done
export function nextAfterCompletion(rule, doneOn) {
  const d = toN(doneOn), n = rule.interval || 1;
  if (rule.freq === 'daily') return toIso(d + n);
  if (rule.freq === 'weekly') return toIso(d + 7 * n);
  if (rule.freq === 'monthly') return toIso(addMonthsN(d, n));
  return toIso(addMonthsN(d, 12 * n));
}
// What completing (or skipping) a repeating to-do does: the next date (after max(its date, today)), or the end of the series.
// done: completions so far (before this one). Returns { next, rule (with anchor), ended }.
export function advanceRepeat(task, today, done = 0) {
  let rule = null;
  try { rule = task.repeat_rule ? JSON.parse(task.repeat_rule) : null; } catch (e) { rule = null; }
  rule = rule || ruleFromRecurrence(task.recurrence);
  const date = task.due_date || today;
  const anchor = rule.anchor || date;
  const base = date > today ? date : today;
  const next = rule.mode === 'after' ? nextAfterCompletion(rule, today) : nextOnSchedule(rule, base, anchor);
  const e = rule.end || null;
  const ended = !!e && !!((e.after && done + 1 >= e.after) || (e.on && next > e.on));
  return { next, ended, rule: { ...rule, anchor } };
}

// Validate v1 task fields. Returns { fields, extras } (extras: checklist/tags written separately) or { error }.
// `creating` allows the create-only suggestion fields.
export function validateV1(body, { creating = false } = {}) {
  const f = {}, extras = {};
  if ('start' in body) {
    const s = body.start;
    if (!STARTS.includes(s)) return { error: 'start must be inbox, anytime, someday or date' };
    if (s === 'date') {
      const d = body.start_date ?? body.due_date;
      if (!isDate(d)) return { error: 'start: date needs start_date (YYYY-MM-DD)' };
      Object.assign(f, { due_date: d, inbox: 0, start: null });
    } else if (s === 'inbox') Object.assign(f, { due_date: null, inbox: 1, start: null, evening: 0 });
    else Object.assign(f, { due_date: null, inbox: 0, start: s, evening: 0 });
  } else if ('start_date' in body) {
    if (!isDate(body.start_date)) return { error: 'Invalid start_date' };
    Object.assign(f, { due_date: body.start_date, inbox: 0 });
  }
  if ('evening' in body) {
    if (typeof body.evening !== 'boolean') return { error: 'evening must be boolean' };
    f.evening = body.evening ? 1 : 0;
  }
  if ('deadline' in body) {
    if (body.deadline !== null && !isDate(body.deadline)) return { error: 'Invalid deadline (YYYY-MM-DD or null)' };
    f.deadline = body.deadline;
  }
  if ('flagged' in body) {
    if (typeof body.flagged !== 'boolean') return { error: 'flagged must be boolean' };
    f.flagged = body.flagged ? 1 : 0;
  }
  for (const k of ['area_id', 'project_id', 'heading_id']) {
    if (k in body) {
      if (body[k] !== null && (typeof body[k] !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(body[k]))) return { error: `Invalid ${k}` };
      f[k] = body[k];
    }
  }
  if ('reminder_at' in body) {
    if (body.reminder_at !== null && !isIso(body.reminder_at)) return { error: 'reminder_at must be an ISO date-time or null' };
    f.reminder_at = body.reminder_at === null ? null : new Date(body.reminder_at).toISOString();
  }
  if ('repeat' in body) {
    const r = validateRule(body.repeat);
    if (r.error) return { error: r.error };
    f.repeat_rule = r.rule ? JSON.stringify(r.rule) : null;
    f.recurrence = recurrenceFromRule(r.rule);
  }
  if ('checklist' in body) {
    const c = body.checklist;
    if (!Array.isArray(c) || c.length > 100) return { error: 'checklist must be an array (max 100)' };
    const items = [];
    for (const it of c) {
      const title = typeof it === 'string' ? it : it && it.title;
      if (typeof title !== 'string' || !title.trim() || title.length > 200) return { error: 'checklist items need a title (max 200)' };
      items.push({ title: title.trim(), done: !!(it && it.done) });
    }
    extras.checklist = items;
  }
  if ('tags' in body) {
    const t = body.tags;
    if (!Array.isArray(t) || t.length > 20 || !t.every(x => typeof x === 'string' && x.trim() && x.length <= 40)) return { error: 'tags must be up to 20 names (max 40 chars)' };
    extras.tags = [...new Set(t.map(x => x.trim()))];
  }
  for (const k of ['today_index', 'sort_index']) {
    if (k in body) {
      if (body[k] !== null && !Number.isFinite(body[k])) return { error: `${k} must be a number or null` };
      f[k] = body[k];
    }
  }
  if ('suggestion_state' in body) {
    // 'pending' only undoes an accept/dismiss of a Claude suggestion
    if (!['accepted', 'dismissed', 'pending'].includes(body.suggestion_state)) return { error: 'suggestion_state must be accepted, dismissed or pending' };
    f.suggestion_state = body.suggestion_state;
  }
  if (creating && body.source !== undefined) {
    if (body.source !== 'claude') return { error: "source must be 'claude'" };
    if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 200) return { error: 'A Claude suggestion needs a one-line reason (max 200)' };
    Object.assign(f, { source: 'claude', reason: body.reason.trim(), suggestion_state: 'pending', inbox: 1, due_date: null, start: null });
  }
  return { fields: f, extras };
}

// Keep v0 and v1 fields consistent after validation (both directions). `existing` is the row being patched (or null).
export async function syncCompat(env, fields, body, existing) {
  // v0 area text -> v1 area id, and back
  if ('area' in fields && !('area_id' in fields)) fields.area_id = v1AreaForV0(fields.area);
  if ('area_id' in fields && !('area' in fields)) fields.area = v0AreaForV1(fields.area_id);
  // Project placement: the to-do lives in the project's area
  if (fields.project_id) {
    const p = await env.DB.prepare("SELECT id, area_id FROM projects WHERE tenant_id = 'owner' AND id = ?").bind(fields.project_id).first();
    if (!p) return { error: 'Unknown project_id' };
    fields.area_id = p.area_id; fields.area = v0AreaForV1(p.area_id);
  } else if ('project_id' in fields && !('heading_id' in fields)) fields.heading_id = null;
  if (fields.heading_id) {
    const h = await env.DB.prepare("SELECT id, project_id FROM headings WHERE tenant_id = 'owner' AND id = ?").bind(fields.heading_id).first();
    const projectId = 'project_id' in fields ? fields.project_id : existing && existing.project_id;
    if (!h || h.project_id !== projectId) return { error: 'heading_id must belong to the to-do\'s project' };
  }
  if (fields.area_id) {
    const a = await env.DB.prepare("SELECT id FROM areas WHERE tenant_id = 'owner' AND id = ?").bind(fields.area_id).first();
    if (!a) return { error: 'Unknown area_id' };
  }
  // v0 priority -> v1 flag (one-offs only), unless the caller set flagged explicitly
  if ('priority' in fields && !('flagged' in fields)) {
    const recurring = 'recurrence' in fields ? fields.recurrence : existing && existing.recurrence;
    if (!recurring) fields.flagged = fields.priority === 'P0' ? 1 : 0;
  }
  // v1 flag -> v0 priority (P0 reads as "flagged" to v0 clients); unflagging only demotes a P0 that was a flag
  if ('flagged' in fields && !('priority' in fields)) {
    if (fields.flagged) fields.priority = 'P0';
    else if (existing && existing.flagged && existing.priority === 'P0') fields.priority = 'P2';
  }
  // v0 recurrence -> v1 rule
  if ('recurrence' in fields && !('repeat_rule' in fields)) fields.repeat_rule = fields.recurrence ? JSON.stringify(ruleFromRecurrence(fields.recurrence)) : null;
  // Evening only means something for a dated to-do
  if ('due_date' in fields && !fields.due_date && !('evening' in fields)) fields.evening = 0;
  return { ok: true };
}

// Replace checklist / tags for a task (extras from validateV1)
export function extrasStmts(env, taskId, extras) {
  const stmts = [];
  if (extras.checklist) {
    stmts.push(env.DB.prepare('DELETE FROM checklist_items WHERE task_id = ?').bind(taskId));
    extras.checklist.forEach((it, i) => stmts.push(env.DB.prepare('INSERT INTO checklist_items (id, task_id, title, done, sort) VALUES (?, ?, ?, ?, ?)')
      .bind(newId('c-'), taskId, it.title, it.done ? 1 : 0, i)));
  }
  if (extras.tags) {
    stmts.push(env.DB.prepare('DELETE FROM task_tags WHERE task_id = ?').bind(taskId));
    for (const name of extras.tags) {
      stmts.push(env.DB.prepare("INSERT INTO tags (id, tenant_id, title, sort) SELECT ?, 'owner', ?, 0 WHERE NOT EXISTS (SELECT 1 FROM tags WHERE tenant_id = 'owner' AND lower(title) = lower(?))")
        .bind(newId('g-'), name, name));
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) SELECT ?, id FROM tags WHERE tenant_id = 'owner' AND lower(title) = lower(?)").bind(taskId, name));
    }
  }
  return stmts;
}

// Add v1 views of a task row: start, flags as booleans, repeat rule, checklist, tags
export async function decorate(env, rows) {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const checklist = new Map(), tags = new Map();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90), ph = chunk.map(() => '?').join(',');
    const c = (await env.DB.prepare(`SELECT task_id, id, title, done FROM checklist_items WHERE task_id IN (${ph}) ORDER BY sort`).bind(...chunk).all()).results || [];
    for (const r of c) (checklist.get(r.task_id) || checklist.set(r.task_id, []).get(r.task_id)).push({ id: r.id, title: r.title, done: !!r.done });
    const t = (await env.DB.prepare(`SELECT tt.task_id, g.title FROM task_tags tt JOIN tags g ON g.id = tt.tag_id WHERE tt.task_id IN (${ph}) ORDER BY g.title`).bind(...chunk).all()).results || [];
    for (const r of t) (tags.get(r.task_id) || tags.set(r.task_id, []).get(r.task_id)).push(r.title);
  }
  return rows.map(r => {
    let repeat = null;
    if (r.repeat_rule) { try { repeat = JSON.parse(r.repeat_rule); } catch (e) { repeat = null; } }
    else if (r.recurrence) repeat = ruleFromRecurrence(r.recurrence);
    return {
      ...r, start: effectiveStart(r), start_date: r.due_date || null,
      area_id: r.area_id ?? (r.list === 'Birthdays' ? 'a-people' : v1AreaForV0(r.area)), evening: !!r.evening, flagged: !!r.flagged, // area_id: unmigrated rows read through the v0 mapping
      repeat, checklist: checklist.get(r.id) || [], tags: tags.get(r.id) || [],
      status: r.trashed_at ? 'trashed' : r.dropped_at ? 'canceled' : r.completed_at ? 'completed' : 'open',
    };
  });
}

// A Claude suggestion is a duplicate if a similar title is open, or was dismissed in the last 14 days (either store)
export async function suggestionDuplicate(env, title) {
  const t = title.trim().toLowerCase(), head = t.slice(0, 18);
  const sim = (col) => `(lower(${col}) = ? OR instr(?, substr(lower(${col}), 1, 18)) = 1 OR instr(lower(${col}), ?) = 1)`;
  const open = await env.DB.prepare(`SELECT id FROM tasks WHERE tenant_id = 'owner' AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL
      AND COALESCE(suggestion_state, 'accepted') != 'dismissed' AND ${sim('title')} LIMIT 1`).bind(t, t, head).first();
  if (open) return { id: open.id, why: 'open' };
  const dismissed = await env.DB.prepare(`SELECT id FROM tasks WHERE tenant_id = 'owner' AND suggestion_state = 'dismissed' AND updated_at >= datetime('now', '-14 day') AND ${sim('title')} LIMIT 1`).bind(t, t, head).first();
  if (dismissed) return { id: dismissed.id, why: 'dismissed' };
  const old = await env.DB.prepare(`SELECT id FROM suggestions WHERE status != 'pending' AND created_at >= datetime('now', '-14 day') AND ${sim('title')} LIMIT 1`).bind(t, t, head).first();
  if (old) return { id: old.id, why: 'dismissed' };
  return null;
}

// ---- Areas / projects / headings (agent API) ----
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const clipTitle = (v, max = 200) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

export async function areasList(env) {
  const areas = (await env.DB.prepare("SELECT * FROM areas WHERE tenant_id = 'owner' AND archived_at IS NULL ORDER BY sort, title").all()).results || [];
  const projects = (await env.DB.prepare(`SELECT p.*, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.completed_at IS NULL AND t.dropped_at IS NULL AND t.trashed_at IS NULL) AS open_count,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.trashed_at IS NULL) AS total_count
    FROM projects p WHERE p.tenant_id = 'owner' AND p.trashed_at IS NULL ORDER BY p.sort, p.title`).all()).results || [];
  const loose = (await env.DB.prepare(`SELECT area_id, COUNT(*) AS n FROM tasks WHERE tenant_id = 'owner' AND project_id IS NULL AND parent_task_id IS NULL
    AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL AND COALESCE(list, 'Tasks') != 'Claude' GROUP BY area_id`).all()).results || [];
  return areas.map(a => ({ ...a, open_loose: (loose.find(l => l.area_id === a.id) || {}).n || 0, projects: projects.filter(p => p.area_id === a.id) }));
}

export async function handleStructure(request, env, ctx, url, path, method, emit) {
  const body = async () => { try { return await request.json(); } catch (e) { return undefined; } };
  const now = new Date().toISOString();
  // Areas
  if (path === '/api/agent/areas' && method === 'GET') return json({ areas: await areasList(env) });
  if (path === '/api/agent/areas' && method === 'POST') {
    const b = await body(); const title = clipTitle(b && b.title, 60);
    if (!title) return json({ error: 'title required (max 60)' }, 400);
    const id = newId('a-');
    await env.DB.prepare("INSERT INTO areas (id, tenant_id, title, sort, created_at) VALUES (?, 'owner', ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM areas), ?)").bind(id, title, now).run();
    emit('area_created', { id });
    return json(await env.DB.prepare('SELECT * FROM areas WHERE id = ?').bind(id).first(), 201);
  }
  let m = path.match(/^\/api\/agent\/areas\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'PATCH') {
    const b = await body(); if (!b) return json({ error: 'Invalid JSON' }, 400);
    const a = await env.DB.prepare("SELECT * FROM areas WHERE tenant_id = 'owner' AND id = ?").bind(m[1]).first();
    if (!a) return json({ error: 'Not found' }, 404);
    const sets = [], vals = [];
    if ('title' in b) { const t = clipTitle(b.title, 60); if (!t) return json({ error: 'Invalid title' }, 400); sets.push('title = ?'); vals.push(t); }
    if ('sort' in b) { if (!Number.isFinite(b.sort)) return json({ error: 'Invalid sort' }, 400); sets.push('sort = ?'); vals.push(b.sort); }
    if ('archived' in b) { if (typeof b.archived !== 'boolean') return json({ error: 'archived must be boolean' }, 400); sets.push('archived_at = ?'); vals.push(b.archived ? now : null); }
    if (!sets.length) return json({ error: 'No fields to update' }, 400);
    await env.DB.prepare(`UPDATE areas SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, m[1]).run();
    return json(await env.DB.prepare('SELECT * FROM areas WHERE id = ?').bind(m[1]).first());
  }
  // Projects
  if (path === '/api/agent/projects' && method === 'GET') {
    const status = url.searchParams.get('status') || 'open';
    if (!['open', 'completed', 'canceled', 'all'].includes(status)) return json({ error: 'status must be open, completed, canceled or all' }, 400);
    let sql = "SELECT * FROM projects WHERE tenant_id = 'owner' AND trashed_at IS NULL"; const binds = [];
    if (status !== 'all') { sql += ' AND status = ?'; binds.push(status); }
    if (url.searchParams.get('area_id')) { sql += ' AND area_id = ?'; binds.push(url.searchParams.get('area_id')); }
    const rows = (await env.DB.prepare(sql + ' ORDER BY sort, title').bind(...binds).all()).results || [];
    const headings = (await env.DB.prepare("SELECT * FROM headings WHERE tenant_id = 'owner' AND archived_at IS NULL ORDER BY sort").all()).results || [];
    return json({ count: rows.length, projects: rows.map(p => ({ ...p, headings: headings.filter(h => h.project_id === p.id) })) });
  }
  if (path === '/api/agent/projects' && method === 'POST') {
    const b = await body(); if (!b) return json({ error: 'Invalid JSON' }, 400);
    const v = await projectFields(env, b, true); if (v.error) return json({ error: v.error }, 400);
    const id = newId('p-');
    const f = { area_id: null, notes: null, start: 'anytime', start_date: null, deadline: null, ...v.fields };
    await env.DB.prepare(`INSERT INTO projects (id, tenant_id, area_id, title, notes, start, start_date, deadline, status, sort, created_at, updated_at)
      VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, 'open', (SELECT COALESCE(MAX(sort), 0) + 1 FROM projects), ?, ?)`)
      .bind(id, f.area_id, f.title, f.notes, f.start, f.start_date, f.deadline, now, now).run();
    emit('project_created', { id, area_id: f.area_id });
    return json(await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(id).first(), 201);
  }
  m = path.match(/^\/api\/agent\/projects\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'PATCH') {
    const b = await body(); if (!b) return json({ error: 'Invalid JSON' }, 400);
    const p = await env.DB.prepare("SELECT * FROM projects WHERE tenant_id = 'owner' AND id = ?").bind(m[1]).first();
    if (!p) return json({ error: 'Not found' }, 404);
    const v = await projectFields(env, b, false); if (v.error) return json({ error: v.error }, 400);
    const f = v.fields;
    if ('status' in b) {
      if (!['open', 'completed', 'canceled'].includes(b.status)) return json({ error: 'status must be open, completed or canceled' }, 400);
      f.status = b.status;
      f.completed_at = b.status === 'completed' ? now : null;
      f.canceled_at = b.status === 'canceled' ? now : null;
    }
    if (!Object.keys(f).length) return json({ error: 'No fields to update' }, 400);
    const cols = Object.keys(f);
    const stmts = [env.DB.prepare(`UPDATE projects SET ${cols.map(c => c + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`).bind(...cols.map(c => f[c]), now, m[1])];
    // Moving a project moves its to-dos' area with it
    if ('area_id' in f) stmts.push(env.DB.prepare('UPDATE tasks SET area_id = ?, area = ?, updated_at = ? WHERE project_id = ?').bind(f.area_id, v0AreaForV1(f.area_id), now, m[1]));
    await env.DB.batch(stmts);
    if (f.status && f.status !== p.status) emit('project_' + f.status, { id: m[1] });
    return json(await env.DB.prepare('SELECT * FROM projects WHERE id = ?').bind(m[1]).first());
  }
  // Headings
  if (path === '/api/agent/headings' && method === 'POST') {
    const b = await body(); const title = clipTitle(b && b.title, 120);
    if (!title || !b.project_id) return json({ error: 'project_id and title required' }, 400);
    const p = await env.DB.prepare("SELECT id FROM projects WHERE tenant_id = 'owner' AND id = ?").bind(b.project_id).first();
    if (!p) return json({ error: 'Unknown project_id' }, 400);
    const id = newId('h-');
    await env.DB.prepare("INSERT INTO headings (id, tenant_id, project_id, title, sort, created_at) VALUES (?, 'owner', ?, ?, (SELECT COALESCE(MAX(sort), 0) + 1 FROM headings WHERE project_id = ?), ?)")
      .bind(id, b.project_id, title, b.project_id, now).run();
    return json(await env.DB.prepare('SELECT * FROM headings WHERE id = ?').bind(id).first(), 201);
  }
  m = path.match(/^\/api\/agent\/headings\/([A-Za-z0-9_-]+)$/);
  if (m && method === 'PATCH') {
    const b = await body(); if (!b) return json({ error: 'Invalid JSON' }, 400);
    const h = await env.DB.prepare("SELECT * FROM headings WHERE tenant_id = 'owner' AND id = ?").bind(m[1]).first();
    if (!h) return json({ error: 'Not found' }, 404);
    const sets = [], vals = [];
    if ('title' in b) { const t = clipTitle(b.title, 120); if (!t) return json({ error: 'Invalid title' }, 400); sets.push('title = ?'); vals.push(t); }
    if ('sort' in b) { if (!Number.isFinite(b.sort)) return json({ error: 'Invalid sort' }, 400); sets.push('sort = ?'); vals.push(b.sort); }
    if ('archived' in b) { if (typeof b.archived !== 'boolean') return json({ error: 'archived must be boolean' }, 400); sets.push('archived_at = ?'); vals.push(b.archived ? now : null); }
    if (!sets.length) return json({ error: 'No fields to update' }, 400);
    await env.DB.prepare(`UPDATE headings SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, m[1]).run();
    return json(await env.DB.prepare('SELECT * FROM headings WHERE id = ?').bind(m[1]).first());
  }
  return null;
}

async function projectFields(env, b, creating) {
  const f = {};
  if (creating || 'title' in b) { const t = clipTitle(b.title); if (!t) return { error: 'title required (max 200)' }; f.title = t; }
  if ('notes' in b) { if (b.notes !== null && (typeof b.notes !== 'string' || b.notes.length > 10000)) return { error: 'Invalid notes' }; f.notes = b.notes || null; }
  if ('area_id' in b) {
    if (b.area_id !== null) {
      const a = await env.DB.prepare("SELECT id FROM areas WHERE tenant_id = 'owner' AND id = ?").bind(b.area_id).first();
      if (!a) return { error: 'Unknown area_id' };
    }
    f.area_id = b.area_id;
  }
  if ('start' in b) {
    if (!['anytime', 'someday', 'date'].includes(b.start)) return { error: 'project start must be anytime, someday or date' };
    if (b.start === 'date' && !isDate(b.start_date)) return { error: 'start: date needs start_date' };
    f.start = b.start; f.start_date = b.start === 'date' ? b.start_date : null;
  }
  if ('deadline' in b) { if (b.deadline !== null && !isDate(b.deadline)) return { error: 'Invalid deadline' }; f.deadline = b.deadline; }
  return { fields: f };
}

// ---- v0 -> v1 migration (dry run and apply) ----
// body: { deadlines?: { taskId: 'YYYY-MM-DD' }, projects?: [{ title, area, task_ids: [] }], flag_repeating?: bool }
export function planMigration(tasks, body = {}) {
  const deadlines = body.deadlines || {};
  const plan = [];
  for (const t of tasks) {
    if (t.parent_task_id) continue;
    const area_id = t.list === 'Birthdays' ? 'a-people' : v1AreaForV0(t.area);
    const open = !t.completed_at && !t.dropped_at;
    let start = null, inbox = t.inbox ? 1 : 0;
    if (open && !t.due_date && !t.inbox) {
      if (!area_id && !t.recurrence) inbox = 1; // untagged and undated -> Inbox for triage
      else start = 'someday'; // undated (former backlog) -> Someday
    }
    const flagged = t.priority === 'P0' && (!t.recurrence || body.flag_repeating === true) ? 1 : 0;
    const deadline = isDate(deadlines[t.id]) ? deadlines[t.id] : null;
    const bucket = !open ? (t.dropped_at ? 'logbook_canceled' : 'logbook_completed') : t.due_date ? 'date' : inbox ? 'inbox' : 'someday';
    plan.push({ id: t.id, area_id, start, inbox, flagged, deadline, repeat_rule: t.recurrence ? JSON.stringify(ruleFromRecurrence(t.recurrence)) : null, bucket, recurrence: t.recurrence || null });
  }
  const summary = {};
  for (const p of plan) {
    const k = p.bucket; summary[k] = summary[k] || { n: 0, by_area: {} };
    summary[k].n++;
    const a = (V1_AREAS.find(x => x.id === p.area_id) || {}).title || '(none)';
    summary[k].by_area[a] = (summary[k].by_area[a] || 0) + 1;
  }
  const projects = (body.projects || []).map(p => ({ title: p.title, area_id: v1AreaForV0(p.area) || (V1_AREAS.find(a => a.title.toLowerCase() === String(p.area || '').toLowerCase()) || {}).id || null, task_ids: (p.task_ids || []).filter(id => plan.some(x => x.id === id)) }));
  return {
    plan, summary, projects,
    flagged_open: plan.filter(p => p.flagged && !p.bucket.startsWith('logbook')).length,
    deadlines: plan.filter(p => p.deadline).length,
    repeats_open: plan.filter(p => p.recurrence && !p.bucket.startsWith('logbook')).length,
  };
}

export async function runMigration(env, body, dryRun, emit) {
  const tasks = (await env.DB.prepare("SELECT * FROM tasks WHERE tenant_id = 'owner'").all()).results || [];
  const done = new Set(((await env.DB.prepare('SELECT DISTINCT task_id FROM migration_log').all()).results || []).map(r => r.task_id));
  const todo = tasks.filter(t => !done.has(t.id));
  const r = planMigration(todo, body);
  const out = { dry_run: dryRun, tasks_total: tasks.length, already_migrated: tasks.length - todo.length, to_migrate: r.plan.length,
    summary: r.summary, flagged_open: r.flagged_open, deadlines: r.deadlines, repeats_open: r.repeats_open,
    projects: r.projects.map(p => ({ title: p.title, area_id: p.area_id, tasks: p.task_ids.length })) };
  if (dryRun) return out;
  const now = new Date().toISOString();
  const stmts = [];
  const byId = new Map(todo.map(t => [t.id, t]));
  for (const p of r.plan) {
    const t = byId.get(p.id);
    stmts.push(env.DB.prepare('UPDATE tasks SET area_id = COALESCE(area_id, ?), start = COALESCE(start, ?), inbox = ?, flagged = MAX(flagged, ?), deadline = COALESCE(deadline, ?), repeat_rule = COALESCE(repeat_rule, ?), created_via = COALESCE(created_via, ?) WHERE id = ?')
      .bind(p.area_id, p.start, p.inbox, p.flagged, p.deadline, p.repeat_rule, 'v0', p.id));
    const log = { area_id: [t.area_id ?? null, p.area_id], start: [t.start ?? null, p.start], inbox: [t.inbox, p.inbox], flagged: [t.flagged ?? 0, p.flagged], deadline: [t.deadline ?? null, p.deadline] };
    for (const [field, [o, n]] of Object.entries(log)) stmts.push(env.DB.prepare('INSERT INTO migration_log (task_id, field, old, new, at) VALUES (?, ?, ?, ?, ?)').bind(p.id, field, o === null ? null : String(o), n === null ? null : String(n), now));
  }
  for (const pr of r.projects) {
    const id = newId('p-');
    stmts.push(env.DB.prepare("INSERT INTO projects (id, tenant_id, area_id, title, start, status, sort, created_at, updated_at) VALUES (?, 'owner', ?, ?, 'anytime', 'open', 0, ?, ?)").bind(id, pr.area_id, pr.title, now, now));
    for (const tid of pr.task_ids) stmts.push(env.DB.prepare('UPDATE tasks SET project_id = ?, area_id = COALESCE(?, area_id) WHERE id = ?').bind(id, pr.area_id, tid));
  }
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  emit('v1_migrated', { tasks: r.plan.length, projects: r.projects.length });
  return out;
}
