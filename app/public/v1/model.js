// my-os v1 client model: pure functions (no DOM), shared by the UI and the tests.
// Days are integers: days since 1970-01-01 (a calendar date, no time zone). Minutes are minutes after local midnight.

export const DAY_MS = 864e5;
export const dnum = (iso) => (iso ? Math.round(Date.parse(String(iso).slice(0, 10) + 'T00:00:00Z') / DAY_MS) : undefined);
export const diso = (d) => new Date(d * DAY_MS).toISOString().slice(0, 10);
export const dateOf = (d) => new Date(d * DAY_MS);
export const dow = (d) => ((d % 7) + 11) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
export const fmtD = (d, o) => dateOf(d).toLocaleDateString('en-US', { ...o, timeZone: 'UTC' });
export const dom = (d) => dateOf(d).getUTCDate();
export const monthOf = (d) => dateOf(d).getUTCMonth();
export const yearOf = (d) => dateOf(d).getUTCFullYear();
export const firstOfMonth = (y, m) => Math.round(Date.UTC(y, m, 1) / DAY_MS);

// Day number and minutes for an instant in a time zone
const fmtCache = {};
export function zoned(instant, tz) {
  const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
  const p = Object.fromEntries(f.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
  return { day: dnum(`${p.year}-${p.month}-${p.day}`), min: (+p.hour % 24) * 60 + +p.minute };
}

export const fmtT = (m) => { const h = Math.floor(m / 60), mm = m % 60; return `${((h + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const fmtDur = (m) => { const h = Math.floor(m / 60), r = m % 60; return h ? (r ? `${h}h ${r}m` : `${h}h`) : `${r}m`; };

// ---- repeats (display only; the server owns completion) ----
// UI shape: {kind: daily|weekly|monthly|yearly, days?: [0-6], dom?: n, interval}
export function repeatFromRule(rule, startDay) {
  if (!rule || !rule.freq) return undefined;
  const r = { kind: rule.freq, interval: rule.interval || 1, mode: rule.mode || 'schedule' };
  if (rule.freq === 'weekly') r.days = rule.byweekday && rule.byweekday.length ? rule.byweekday : startDay !== undefined ? [dow(startDay)] : [];
  if (rule.freq === 'monthly') r.dom = rule.bymonthday || (startDay !== undefined ? dom(startDay) : 1);
  return r;
}
export function occurs(t, d) {
  const r = t.repeat; if (!r || r.mode === 'after') return false;
  if (r.kind === 'daily') return true;
  if (r.kind === 'weekly') return (r.days || []).includes(dow(d));
  if (r.kind === 'monthly') return r.dom === -1 ? dom(d + 1) === 1 : dom(d) === r.dom;
  if (r.kind === 'yearly') { const a = t.date; return monthOf(a) === monthOf(d) && dom(a) === dom(d); }
  return false;
}
const UNIT = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };
export function repeatText(r, rule) {
  const n = r.interval || 1, every = n > 1 ? `every ${n} ${UNIT[r.kind]}s` : r.kind;
  let t;
  if (r.mode === 'after') t = `${n > 1 ? every : 'every ' + UNIT[r.kind]} after completion`;
  else if (r.kind === 'weekly' && r.days && r.days.length) t = (r.days.join() === '1,2,3,4,5' && n === 1 ? 'every weekday' : `${every} on ` + r.days.map((x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]).join(', '));
  else if (r.kind === 'monthly') t = `${every} on the ${r.dom === -1 ? 'last day' : ordinal(r.dom)}`;
  else t = every;
  const e = rule && rule.end;
  if (e && e.after) t += `, ${e.after} times`;
  if (e && e.on) t += `, until ${fmtD(dnum(e.on), { month: 'short', day: 'numeric', year: 'numeric' })}`;
  return t;
}
export const ordinal = (n) => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
// Comparable form of a repeat rule (the server keeps `anchor` itself)
export function ruleKey(rule) {
  if (!rule || !rule.freq) return null;
  const o = { mode: rule.mode || 'schedule', freq: rule.freq, interval: rule.interval || 1 };
  if (rule.byweekday && rule.byweekday.length) o.byweekday = [...rule.byweekday].sort();
  if (rule.bymonthday) o.bymonthday = rule.bymonthday;
  if (rule.end && (rule.end.after || rule.end.on)) o.end = rule.end.after ? { after: rule.end.after } : { on: rule.end.on };
  return JSON.stringify(o);
}

// ---- server row <-> UI to-do ----
export function fromServer(r, tz) {
  const t = {
    id: r.id, title: r.title || '', notes: r.notes || '',
    start: r.start, date: r.start === 'date' ? dnum(r.start_date || r.due_date) : undefined,
    evening: !!r.evening, area: r.area_id || undefined, project: r.project_id || undefined, heading: r.heading_id || undefined,
    deadline: r.deadline ? dnum(r.deadline) : undefined, flag: !!r.flagged,
    checklist: r.checklist && r.checklist.length ? r.checklist.map((c) => ({ t: c.title, d: !!c.done })) : undefined,
    tags: r.tags && r.tags.length ? [...r.tags] : undefined,
    ti: r.today_index ?? undefined, si: r.sort_index ?? undefined,
    reminder: r.reminder_at || undefined,
    list: r.list, source: r.source || undefined,
  };
  t.rule = r.repeat || undefined;
  t.repeat = repeatFromRule(r.repeat, t.date);
  if (r.status === 'completed') { t.done = true; t.logged = true; t.stop = zoned(r.completed_at, tz).day; }
  if (r.status === 'canceled') { t.done = true; t.logged = true; t.canceled = true; t.stop = zoned(r.dropped_at, tz).day; }
  if (r.status === 'trashed') t.trashed = true;
  if (r.source === 'claude' && r.suggestion_state === 'pending') t.sugg = r.reason || '';
  else if (r.source === 'claude') t.reason = r.reason || '';
  return t;
}

export function claudeFromServer(r, tz) {
  return { id: r.id, title: r.title, notes: r.notes || '', date: r.start_date ? dnum(r.start_date) : undefined, done: r.status === 'completed', stop: r.completed_at ? zoned(r.completed_at, tz).day : undefined };
}

// The fields the server stores, from a UI to-do (compared to find what to send)
export function wire(t) {
  const dated = t.start === 'date' && t.date !== undefined;
  return {
    title: (t.title || '').trim(), notes: (t.notes || '').trim() ? t.notes : null,
    start: t.start, start_date: dated ? diso(t.date) : null, evening: dated && !!t.evening,
    project_id: t.project || null, heading_id: t.project ? t.heading || null : null, area_id: t.project ? null : t.area || null,
    deadline: t.deadline !== undefined ? diso(t.deadline) : null, flagged: !!t.flag,
    tags: [...(t.tags || [])].sort().join('\u0001'), checklist: JSON.stringify((t.checklist || []).map((c) => [c.t, !!c.d])),
    today_index: t.ti ?? null, sort_index: t.si ?? null, repeat: ruleKey(t.rule),
    completed: !!(t.logged && !t.canceled), canceled: !!t.canceled,
    trashed: !!(t.trashed && !t.dismissed),
    suggestion_state: t.source === 'claude' ? (t.dismissed ? 'dismissed' : t.sugg !== undefined ? 'pending' : 'accepted') : null,
  };
}

// PATCH body that turns server state `b` (a wire()) into `w` (a wire()); {} when nothing changed.
// project_id wins over area_id (the server puts a project's to-dos in its area).
export function diffPatch(b, w) {
  const p = {};
  if (w.trashed !== b.trashed) p.trashed = w.trashed;
  if (w.suggestion_state !== b.suggestion_state && w.suggestion_state) p.suggestion_state = w.suggestion_state;
  if (w.completed !== b.completed) p.completed = w.completed;
  if (w.canceled !== b.canceled) p.canceled = w.canceled;
  if (w.title !== b.title && w.title) p.title = w.title;
  if (w.notes !== b.notes) p.notes = w.notes;
  if (w.start !== b.start || w.start_date !== b.start_date) { p.start = w.start; if (w.start === 'date') p.start_date = w.start_date; }
  if (w.evening !== b.evening && (w.start === 'date' || !w.evening)) p.evening = w.evening;
  if (w.project_id !== b.project_id || w.heading_id !== b.heading_id || (!w.project_id && w.area_id !== b.area_id)) {
    p.project_id = w.project_id; p.heading_id = w.heading_id;
    if (!w.project_id) p.area_id = w.area_id;
  }
  if (w.deadline !== b.deadline) p.deadline = w.deadline;
  if (w.flagged !== b.flagged) p.flagged = w.flagged;
  if (w.tags !== b.tags) p.tags = w.tags ? w.tags.split('\u0001') : [];
  if (w.checklist !== b.checklist) p.checklist = JSON.parse(w.checklist).map(([title, done]) => ({ title, done }));
  if (w.today_index !== b.today_index) p.today_index = w.today_index;
  if (w.sort_index !== b.sort_index) p.sort_index = w.sort_index;
  if (w.repeat !== b.repeat) p.repeat = w.repeat ? JSON.parse(w.repeat) : null;
  return p;
}

// Body for creating a to-do from a UI to-do
export function createBody(t) {
  const w = wire(t), b = { title: w.title, start: w.start };
  if (w.start === 'date') { b.start_date = w.start_date; b.evening = w.evening; }
  if (w.notes) b.notes = w.notes;
  if (w.project_id) { b.project_id = w.project_id; if (w.heading_id) b.heading_id = w.heading_id; } else if (w.area_id) b.area_id = w.area_id;
  if (w.deadline) b.deadline = w.deadline;
  if (w.flagged) b.flagged = true;
  if (t.tags && t.tags.length) b.tags = [...t.tags];
  if (t.checklist && t.checklist.length) b.checklist = t.checklist.map((c) => ({ title: c.t, done: !!c.d }));
  if (w.today_index !== null) b.today_index = w.today_index;
  if (w.sort_index !== null) b.sort_index = w.sort_index;
  if (w.repeat) b.repeat = JSON.parse(w.repeat);
  return b;
}

// ---- calendar ----
// events from /api/v1/state -> { day: [[startMin|null, endMin|null, title, kind, busy]] }. Timed events crossing midnight are split.
export function calKind(e) { return e.busy ? 'work' : e.cal === 'primary' ? 'personal' : 'family'; }
export function buildEvents(events, tz) {
  const out = {};
  const push = (d, row) => (out[d] || (out[d] = [])).push(row);
  for (const e of events) {
    const kind = calKind(e);
    if (e.all_day) {
      const a = dnum(e.start_date || e.start), z = e.end_date ? dnum(e.end_date) : a + 1;
      for (let d = a; d < Math.max(z, a + 1) && d < a + 60; d++) push(d, [null, null, e.title || 'Busy', kind, e.busy && !e.labeled ? 1 : 0, e.id]);
      continue;
    }
    const s = zoned(e.start, tz), z = zoned(e.end, tz);
    for (let d = s.day; d <= z.day && d < s.day + 14; d++) {
      const a = d === s.day ? s.min : 0, b = d === z.day ? z.min : 1440;
      if (b > a || (d === s.day && b === a)) push(d, [a, b, e.title || 'Busy', kind, e.busy && !e.labeled ? 1 : 0, e.id]);
    }
  }
  for (const d in out) out[d].sort((x, y) => (x[0] ?? -1) - (y[0] ?? -1));
  return out;
}

// ---- When field: tomorrow, fri, next tue, in 3 days, 2w, tonight, someday, oct 20, 10/20 ----
const NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseWhen(s, today) {
  s = String(s || '').trim().toLowerCase(); if (!s) return null;
  if (/^(today|tod)$/.test(s)) return 'today';
  if (/^(tonight|evening|this evening|eve)$/.test(s)) return 'evening';
  if (/^(someday|later)$/.test(s)) return 'someday';
  if (/^(anytime|clear)$/.test(s)) return 'clear';
  if (/^(tomorrow|tmr|tom|tmrw)$/.test(s)) return 'd1';
  let m = s.match(/^(?:in )?(\d+)\s*(d|days?|w|weeks?|m|months?)$/);
  if (m) { const n = +m[1], u = m[2][0]; if (u === 'm') { return 'd' + (addMonths(today, n) - today); } return 'd' + n * (u === 'w' ? 7 : 1); }
  if (/^next week$/.test(s)) return 'd' + (((1 - dow(today) + 7) % 7) || 7);
  m = s.match(/^(next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/);
  if (m) { let k = (NAMES.indexOf(m[2]) - dow(today) + 7) % 7 || 7; if (m[1] && k < 7) k += 7; return 'd' + k; }
  m = s.match(/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})$/) || s.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) {
    const mo = isNaN(+m[1]) ? MONTHS.indexOf(m[1].slice(0, 3)) : +m[1] - 1, da = +m[2];
    if (mo < 0 || mo > 11 || da < 1 || da > 31) return null;
    let y = yearOf(today), d = Math.round(Date.UTC(y, mo, da) / DAY_MS);
    if (dom(d) !== da) return null;
    if (d < today) d = Math.round(Date.UTC(y + 1, mo, da) / DAY_MS);
    return 'd' + (d - today);
  }
  return null;
}
function addMonths(d, n) { const y = yearOf(d), m = monthOf(d) + n, x = dom(d); const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); return Math.round(Date.UTC(y, m, Math.min(x, last)) / DAY_MS); }

// ---- brief markdown -> { title, blocks: [{h|p|li, text}] } (no HTML passes through) ----
export function parseBrief(md) {
  const out = { title: null, blocks: [] };
  let para = [];
  const flushP = () => { if (para.length) { out.blocks.push({ k: 'p', text: para.join(' ') }); para = []; } };
  for (const raw of String(md || '').split('\n')) {
    const l = raw.trim();
    if (!l) { flushP(); continue; }
    let m = l.match(/^#{1,6}\s+(.*)$/);
    if (m) { flushP(); if (!out.title) out.title = strip(m[1]); else out.blocks.push({ k: 'h', text: strip(m[1]) }); continue; }
    m = l.match(/^[-*•]\s+(.*)$/);
    if (m) { flushP(); out.blocks.push({ k: 'li', text: strip(m[1]) }); continue; }
    para.push(strip(l));
  }
  flushP();
  return out;
}
const strip = (s) => s.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/(^|\W)_(.+?)_(\W|$)/g, '$1$2$3').replace(/`(.+?)`/g, '$1').replace(/\[(.+?)\]\((.+?)\)/g, '$1');
