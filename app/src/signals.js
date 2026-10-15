// Task signals (B28 why-later, B29 outcome, B30 won't do): pure helpers, no I/O.
// Imported by the Worker (src/index.js) and by scripts/test-signals.mjs.

export const LATER_REASONS = {
  no_time: 'No time',
  waiting: 'Waiting on someone',
  not_important: 'Not important now',
  blocked: 'Blocked',
};

export const DROP_REASONS = {
  not_worth_it: 'Not worth it',
  someone_else: 'Someone else did it',
  overtaken: 'Overtaken by events',
  changed_mind: 'Changed my mind',
  duplicate: 'Duplicate',
};

// Accept a reason code ("waiting") or its label ("Waiting on someone", any case).
// Returns { code } (code null when absent) or { error }.
export function normalizeReason(value, table) {
  if (value === undefined || value === null || value === '') return { code: null };
  if (typeof value !== 'string') return { error: 'Invalid reason' };
  const v = value.trim();
  if (Object.prototype.hasOwnProperty.call(table, v)) return { code: v };
  const lower = v.toLowerCase();
  for (const [code, label] of Object.entries(table)) {
    if (label.toLowerCase() === lower) return { code };
  }
  return { error: 'Invalid reason (one of: ' + Object.keys(table).join(', ') + ')' };
}

// Free text for a signal: one line, trimmed, capped. Returns { text } (null when empty) or { error }.
export function cleanText(value, max) {
  if (value === undefined || value === null) return { text: null };
  if (typeof value !== 'string') return { error: 'Invalid text' };
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return { text: null };
  return { text: t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t };
}

// True when newDate (YYYY-MM-DD) is strictly after oldDate. Undated on either side = false.
export function isLaterDate(oldDate, newDate) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(oldDate || '') || !re.test(newDate || '')) return false;
  return newDate > oldDate;
}

// "2026-10-09" -> "Oct 9" (year added when it differs from today's year)
export function shortDate(dateStr, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return String(dateStr || '');
  const opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (today && dateStr.slice(0, 4) !== String(today).slice(0, 4)) opts.year = 'numeric';
  return new Intl.DateTimeFormat('en-US', opts).format(new Date(dateStr + 'T00:00:00Z'));
}

// "Label (text)", "Label", "text", or "" when both are empty
function reasonPhrase(label, text) {
  if (label && text) return `${label} (${text})`;
  return label || text || '';
}

// One dated notes line. kind: 'snoozed' | 'moved' | 'done' | 'wont_do'.
// opts: { today, to, label, text, detail }  (detail e.g. "skipped Oct 7" / "stopped series")
export function signalLine(kind, opts) {
  const o = opts || {};
  const phrase = reasonPhrase(o.label, o.text);
  if (kind === 'snoozed' || kind === 'moved') {
    return `${o.today} ${kind} → ${shortDate(o.to, o.today)}${phrase ? ': ' + phrase : ''}`;
  }
  if (kind === 'done') return `${o.today} done: ${o.text || ''}`.trimEnd();
  if (kind === 'wont_do') return `${o.today} won't do${o.detail ? ' (' + o.detail + ')' : ''}${phrase ? ': ' + phrase : ''}`;
  if (kind === 'restored') return `${o.today} restored`;
  throw new Error('Unknown signal kind: ' + kind);
}

// Append one line to notes: never overwrites, newest at the bottom.
export function appendNoteLine(notes, line) {
  const base = typeof notes === 'string' ? notes.replace(/\s+$/, '') : '';
  return base ? base + '\n' + line : line;
}

// True when the last non-empty notes line is a won't-do line (so a restore should be noted)
export function endsWithWontDo(notes) {
  if (!notes) return false;
  const lines = String(notes).split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length > 0 && /^\d{4}-\d{2}-\d{2} won't do\b/.test(lines[lines.length - 1]);
}

// Merge reason fields into an event's JSON props string (unknown/invalid JSON starts fresh)
export function mergeProps(propsJson, extra) {
  let p = {};
  if (propsJson) { try { const x = JSON.parse(propsJson); if (x && typeof x === 'object' && !Array.isArray(x)) p = x; } catch (e) { p = {}; } }
  for (const [k, v] of Object.entries(extra || {})) if (v !== undefined && v !== null) p[k] = v;
  return JSON.stringify(p);
}

// YYYY-MM-DD of an ISO timestamp in America/Los_Angeles
export function laDateOf(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t));
  const get = (k) => parts.find(p => p.type === k).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
