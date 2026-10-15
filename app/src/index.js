import {
  LATER_REASONS, DROP_REASONS, normalizeReason, cleanText, signalLine, appendNoteLine,
  endsWithWontDo, mergeProps, laDateOf, shortDate,
} from './signals.js';
import { runCalendarSync, purgeCalendar, calendarChanges, calendarEvents, cursorHealth } from './gcal.js';
import { runMailSync, purgeMail, retagMail, mailMessages, mailThread } from './gmail.js';
import { awaitingMe, awaitingThem, newSince, healthStrip } from './views.js';
import { listAttachments, readAttachment } from './attachments.js';
import { validateV1, syncCompat, extrasStmts, decorate, suggestionDuplicate, handleStructure, runMigration, advanceRepeat } from './v1.js';
import { uploadItemMedia, listItemMedia, rawItemMedia, purgeItemMedia, pendingMedia, reapplySnippets, noteItemMedia } from './media.js';
import { handleV1App, agentFeedback, anomalies, readSettings, agentTime, wake, wakeAck, eventLabels, deviceRequest } from './v1app.js';


// Utility to get today in LA timezone
function getTodayLA() {
  const now = new Date();
  const laFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = laFormatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${year}-${month}-${day}`;
}

// Get tomorrow in LA timezone
function getTomorrowLA() {
  const d = new Date();
  const laFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = laFormatter.formatToParts(d);
  const year = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value);
  const day = parseInt(parts.find(p => p.type === 'day').value);
  const laDate = new Date(year, month - 1, day);
  laDate.setDate(laDate.getDate() + 1);
  return `${laDate.getFullYear()}-${String(laDate.getMonth() + 1).padStart(2, '0')}-${String(laDate.getDate()).padStart(2, '0')}`;
}

// Get next Monday in LA timezone (after LA today)
function getNextMondayLA() {
  const d = new Date();
  const laFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = laFormatter.formatToParts(d);
  const year = parseInt(parts.find(p => p.type === 'year').value);
  const month = parseInt(parts.find(p => p.type === 'month').value);
  const day = parseInt(parts.find(p => p.type === 'day').value);
  const laDate = new Date(year, month - 1, day);
  const dow = laDate.getDay();
  let daysUntilMonday = (1 - dow + 7) % 7;
  if (daysUntilMonday <= 1) daysUntilMonday += 7; // Sunday/Monday: skip to the Monday after
  laDate.setDate(laDate.getDate() + daysUntilMonday);
  return `${laDate.getFullYear()}-${String(laDate.getMonth() + 1).padStart(2, '0')}-${String(laDate.getDate()).padStart(2, '0')}`;
}

// Compute next due date based on recurrence
function advanceDueDate(oldDueDate, recurrence) {
  if (!oldDueDate || !recurrence) return oldDueDate;

  const date = new Date(oldDueDate + 'T00:00:00Z');
  let nextDate = new Date(date);

  if (recurrence === 'daily') {
    nextDate.setUTCDate(nextDate.getUTCDate() + 1);
  } else if (recurrence === 'weekdays') {
    let day = nextDate.getUTCDay();
    if (day === 5) nextDate.setUTCDate(nextDate.getUTCDate() + 3); // Fri -> Mon
    else if (day === 6) nextDate.setUTCDate(nextDate.getUTCDate() + 2); // Sat -> Mon
    else nextDate.setUTCDate(nextDate.getUTCDate() + 1); // Any other day -> +1
  } else if (recurrence === 'weekly') {
    nextDate.setUTCDate(nextDate.getUTCDate() + 7);
  } else if (recurrence === 'monthly') {
    const originalDay = date.getUTCDate();
    let month = nextDate.getUTCMonth() + 1;
    let year = nextDate.getUTCFullYear();
    if (month > 11) {
      month = 0;
      year++;
    }
    // Find last day of target month by going to first of next month, then back 1 day
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 11) {
      nextMonth = 0;
      nextYear++;
    }
    nextDate.setUTCFullYear(nextYear, nextMonth, 1);
    nextDate.setUTCDate(0); // Get to last day of target month
    const lastDay = nextDate.getUTCDate();
    // Set to clamped day
    nextDate.setUTCFullYear(year, month, Math.min(originalDay, lastDay));
  } else if (recurrence === 'yearly') {
    const originalDay = date.getUTCDate();
    const originalMonth = date.getUTCMonth();
    const nextYear = nextDate.getUTCFullYear() + 1;
    // Handle Feb 29 -> Feb 28 for non-leap years
    if (originalMonth === 1 && originalDay === 29) {
      const testDate = new Date(Date.UTC(nextYear, 1, 29));
      if (testDate.getUTCMonth() !== 1) {
        // Feb 29 doesn't exist in target year, use Feb 28
        nextDate.setUTCFullYear(nextYear, 1, 28);
      } else {
        nextDate.setUTCFullYear(nextYear, 1, 29);
      }
    } else {
      nextDate.setUTCFullYear(nextYear, originalMonth, originalDay);
    }
  }

  const year = nextDate.getUTCFullYear();
  const month = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const day = String(nextDate.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const enc = new TextEncoder();

// HMAC-SHA256(passphrase, "myos-v1") as hex — the session token
async function sessionToken(passphrase) {
  const key = await crypto.subtle.importKey('raw', enc.encode(passphrase), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('myos-v1'));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time string compare
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Validate cookie
async function validateSession(cookieHeader, passphrase) {
  if (!cookieHeader || !passphrase) return false;
  const match = cookieHeader.match(/(?:^|;\s*)myos_session=([0-9a-f]+)/);
  if (!match) return false;
  return safeEqual(match[1], await sessionToken(passphrase));
}

// AI cleanup for quick-add text
// {owner} and {household} are filled from env (OWNER_NAME, HOUSEHOLD_CONTEXT) at call time; see buildSystemPrompt().
const AI_SYSTEM_PROMPT = `You turn a captured note into one to-do for {owner} (Pacific time). Today is {today}. Household: {household} Title: imperative, ≤70 chars, keep names/specifics, no filler. due_date: YYYY-MM-DD only if a date/day/urgency is implied, else null. priority: P0 = must happen today or a hard deadline (bills, taxes, daily non-negotiables); P1 = this week and it matters; P2 = default, should happen but the date can slide; P3 = someday / nice-to-have; null if unclear. recurrence only if clearly repeating. Return JSON only.`;

function buildSystemPrompt(env, todayStr) {
  // Function replacers: values are inserted literally (no "$&" style expansion).
  return AI_SYSTEM_PROMPT
    .replace('{owner}', () => String((env && env.OWNER_NAME) || '<OWNER_NAME>'))
    .replace('{household}', () => String((env && env.HOUSEHOLD_CONTEXT) || '<HOUSEHOLD_CONTEXT>'))
    .replace('{today}', () => todayStr);
}

async function cleanupWithAI(env, raw, today) {
  if (!env.AI) return null;

  const todayDate = new Date(today + 'T00:00:00Z');
  const dayName = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(todayDate);
  const todayStr = `${dayName}, ${today}`;

  const systemPrompt = buildSystemPrompt(env, todayStr);

  try {
    const result = await Promise.race([
      env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: raw },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              due_date: { type: ['string', 'null'] },
              priority: { type: ['string', 'null'], enum: ['P0', 'P1', 'P2', 'P3', null] },
              recurrence: { type: ['string', 'null'], enum: ['daily', 'weekdays', 'weekly', 'monthly', 'yearly', null] },
            },
            required: ['title', 'due_date', 'priority'],
          },
        },
        max_tokens: 200,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000)),
    ]);

    let parsed = result.response;
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    return parsed;
  } catch (err) {
    return null;
  }
}

// v1 UI host: any host starting with "v1." plus hosts listed in V1_HOSTS (comma-separated, e.g. for cutover)
function isV1Host(url, env) {
  const extra = String(env.V1_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.toLowerCase();
  return host.startsWith('v1.') || extra.includes(host);
}

// JSON response helper
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const CLIENT_EVENT_KINDS = ['app_open', 'view', 'sheet_opened'];
const AREAS = ['kids', 'family', 'health', 'work', 'venture', 'finance', 'house'];

// Whole days from date a to date b (YYYY-MM-DD)
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// Log an event. Never throws and never blocks the request (runs after the response via waitUntil).
function emit(env, ctx, kind, e = {}) {
  try {
    const p = env.DB.prepare(
      'INSERT INTO events (id, tenant_id, at, kind, task_id, suggestion_id, area, props) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(
      'e-' + generateId(), 'owner', new Date().toISOString(), kind,
      e.task_id || null, e.suggestion_id || null, e.area || null,
      e.props ? JSON.stringify(e.props) : null
    ).run().catch(err => console.error('event write failed', kind, String(err)));
    ctx.waitUntil(p);
  } catch (err) {
    console.error('event failed', kind, String(err));
  }
}

// True for a real calendar date in YYYY-MM-DD form
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// Validate a partial task update; returns { error } or { fields } (column -> value)
function validateTaskPatch(body) {
  if (!body || typeof body !== 'object') return { error: 'Invalid body' };
  const fields = {};
  if ('title' in body) {
    if (typeof body.title !== 'string' || body.title.trim().length === 0 || body.title.length > 200) return { error: 'Invalid title' };
    fields.title = body.title.trim();
  }
  if ('notes' in body) {
    if (body.notes !== null && (typeof body.notes !== 'string' || body.notes.length > 10000)) return { error: 'Invalid notes' };
    fields.notes = body.notes && body.notes.trim() ? body.notes : null;
  }
  if ('due_date' in body) {
    if (!isValidDate(body.due_date)) return { error: 'Invalid due_date' };
    fields.due_date = body.due_date;
  }
  // B43: backlog = no due date. Scheduling (a due_date) takes a task out of the backlog.
  if ('backlog' in body) {
    if (body.backlog !== true) return { error: 'backlog must be true (send a due_date to schedule)' };
    if ('due_date' in body) return { error: 'Send backlog or due_date, not both' };
    fields.due_date = null;
    fields.start = 'someday'; // v1: the backlog is Someday
  }
  if ('recurrence' in body) {
    if (body.recurrence !== null && !['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(body.recurrence)) return { error: 'Invalid recurrence' };
    fields.recurrence = body.recurrence;
  }
  if ('priority' in body) {
    if (body.priority !== null && !['P0', 'P1', 'P2', 'P3'].includes(body.priority)) return { error: 'Invalid priority' };
    fields.priority = body.priority;
  }
  if ('list' in body) {
    if (!['Tasks', 'Birthdays', 'Claude'].includes(body.list)) return { error: 'Invalid list' };
    fields.list = body.list;
  }
  if ('area' in body) {
    if (body.area !== null && !AREAS.includes(body.area)) return { error: 'Invalid area' };
    fields.area = body.area;
  }
  if ('ask_outcome' in body) {
    const v = body.ask_outcome;
    if (![true, false, 0, 1].includes(v)) return { error: 'Invalid ask_outcome (boolean)' };
    fields.ask_outcome = v === true || v === 1 ? 1 : 0;
  }
  // v1 fields (start, evening, deadline, flagged, place, reminder, repeat, checklist, tags, suggestion state)
  const v1 = validateV1(body);
  if (v1.error) return { error: v1.error };
  Object.assign(fields, v1.fields);
  if (Object.keys(fields).length === 0 && Object.keys(v1.extras).length === 0) return { error: 'No fields to update' };
  return { fields, extras: v1.extras };
}

// Shared validation for task creation
function validateTaskFields(title, list, due_date, recurrence, priority) {
  if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    return { valid: false, error: 'Invalid title' };
  }

  const taskList = list || 'Tasks';
  if (!['Tasks', 'Birthdays', 'Claude'].includes(taskList)) {
    return { valid: false, error: 'Invalid list' };
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return { valid: false, error: 'Invalid due_date format' };
  }

  if (recurrence && !['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(recurrence)) {
    return { valid: false, error: 'Invalid recurrence' };
  }

  if (priority && !['P0', 'P1', 'P2', 'P3'].includes(priority)) {
    return { valid: false, error: 'Invalid priority' };
  }

  return { valid: true };
}

// Create session cookie
async function createSessionCookie(passphrase) {
  return `myos_session=${await sessionToken(passphrase)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
}

// Generate short random id
function generateId() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Login page HTML
function getLoginPage() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>my-os Login</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #1f1f1f;
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .login-box {
      background: #2b2b2b;
      padding: 2rem;
      border-radius: 8px;
      width: 90%;
      max-width: 300px;
    }
    h1 {
      text-align: center;
      font-size: 1.5rem;
      margin-bottom: 1.5rem;
    }
    form {
      display: flex;
      flex-direction: column;
      gap: 1rem;
    }
    input {
      padding: 0.75rem;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      background: #1f1f1f;
      color: #fff;
    }
    button {
      padding: 0.75rem;
      background: #5fd3c6;
      color: #000;
      border: none;
      border-radius: 4px;
      font-size: 1rem;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      opacity: 0.9;
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>my-os</h1>
    <form method="POST" action="/login">
      <input type="password" name="passphrase" placeholder="Passphrase" required autofocus>
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`;
}

// ---- Snapshot (read-only markdown for agents) ----
function mdLine(task, today) {
  const one = (t, n) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
  let line = '- ' + (task.priority ? `[${task.priority}] ` : '') + one(task.title, 200);
  const bits = [];
  if (task.area) bits.push(task.area);
  if (task.list && task.list !== 'Tasks') bits.push(task.list);
  if (task.recurrence) bits.push('repeats ' + task.recurrence);
  if (task.starred) bits.push('starred');
  if (task.due_date && task.due_date < today) bits.push(`due ${task.due_date}, ${daysBetween(task.due_date, today)}d overdue`);
  else if (task.due_date) bits.push('due ' + task.due_date);
  if (task.steps_total) bits.push(`steps ${task.steps_done}/${task.steps_total}`);
  // v1 concepts
  if (task.flagged) bits.push('flagged');
  if (task.evening && task.due_date) bits.push('this evening');
  if (task.deadline) bits.push(task.deadline < today ? `deadline ${task.deadline}, ${daysBetween(task.deadline, today)}d past` : task.deadline === today ? 'deadline today' : 'deadline ' + task.deadline);
  if (task.project_title) bits.push('project: ' + one(task.project_title, 80));
  if (bits.length) line += ' (' + bits.join('; ') + ')';
  const firstNote = task.notes ? String(task.notes).split('\n').map(l => l.trim()).find(l => l) : '';
  if (firstNote) line += ' — ' + one(firstNote, 140);
  return line;
}

async function buildSnapshot(env, opts = {}) {
  const today = getTodayLA();
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
  const sunday = addDays(today, dow === 0 ? 0 : 7 - dow);
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);

  const [tasks, completions, doneTasks, suggestions, wontDo] = await Promise.all([
    q(`SELECT t.*, (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id) AS steps_total,
              (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.completed_at IS NOT NULL) AS steps_done,
              (SELECT title FROM projects p WHERE p.id = t.project_id) AS project_title
       FROM tasks t WHERE t.tenant_id = ? AND t.parent_task_id IS NULL AND t.completed_at IS NULL AND t.dropped_at IS NULL AND t.due_date IS NOT NULL AND t.trashed_at IS NULL AND COALESCE(t.suggestion_state, 'accepted') = 'accepted' AND COALESCE(t.list, 'Tasks') != 'Claude'
       ORDER BY t.due_date ASC, CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, t.starred DESC, t.title ASC`, 'owner'),
    q(`SELECT c.completed_at, t.title, t.priority, t.area FROM completions c JOIN tasks t ON t.id = c.task_id
       WHERE c.tenant_id = ? AND c.completed_at >= ? AND t.parent_task_id IS NULL ORDER BY c.completed_at DESC`, 'owner', new Date(Date.now() - 86400000).toISOString()),
    q(`SELECT completed_at, title, priority, area FROM tasks WHERE tenant_id = ? AND parent_task_id IS NULL AND completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC`, 'owner', new Date(Date.now() - 86400000).toISOString()),
    q(`SELECT * FROM suggestions WHERE tenant_id = ? AND status = 'pending' ORDER BY created_at ASC`, 'owner'),
    q(`SELECT e.kind, e.at, e.props, t.title, t.priority, t.area, t.dropped_at FROM events e JOIN tasks t ON t.id = e.task_id
       WHERE e.tenant_id = ? AND e.at >= ? AND e.kind IN ('task_dropped', 'task_skipped') ORDER BY e.at DESC`, 'owner', new Date(Date.now() - 86400000).toISOString()),
  ]);

  const overdue = tasks.filter(t => t.due_date < today);
  const todayOneOff = tasks.filter(t => t.due_date === today && !t.recurrence);
  const todayRecurring = tasks.filter(t => t.due_date === today && t.recurrence);
  const week = tasks.filter(t => t.due_date > today && t.due_date <= sunday);

  const now = new Date();
  const stamp = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now);
  const out = [`# my-os snapshot`, ``, `Generated ${stamp} (Pacific). Today is ${today}. Read-only view of the task app.`, ``];
  const section = (title, items, fmt) => {
    out.push(`## ${title} (${items.length})`);
    if (items.length === 0) out.push('_none_');
    else for (const it of items) out.push(fmt(it));
    out.push('');
  };
  section('Overdue', overdue, t => mdLine(t, today));
  section('Today', todayOneOff, t => mdLine(t, today));
  section('Recurring due today', todayRecurring, t => mdLine(t, today));
  section('This week (through Sunday ' + sunday + ')', week, t => mdLine(t, today));
  // B43: backlog is a count only (undated open tasks), not a list
  const undated = await env.DB.prepare("SELECT SUM(inbox = 1) AS inbox, SUM(inbox = 0) AS backlog FROM tasks WHERE tenant_id = 'owner' AND parent_task_id IS NULL AND completed_at IS NULL AND dropped_at IS NULL AND due_date IS NULL AND trashed_at IS NULL AND COALESCE(suggestion_state, 'accepted') = 'accepted' AND COALESCE(list, 'Tasks') != 'Claude'").first();
  out.push(`## Inbox (${(undated && undated.inbox) || 0})`, '_untriaged quick-adds; list with GET /api/agent/tasks?status=inbox_', '');
  out.push(`## Backlog (${(undated && undated.backlog) || 0})`, '_undated tasks (Someday/Anytime in v1); list with GET /api/agent/tasks?status=backlog_', '');
  // v1: deadlines on to-dos that start later (or are undated), open projects, the Claude list, Claude's pending suggestions
  const live = "parent_task_id IS NULL AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL AND COALESCE(suggestion_state, 'accepted') = 'accepted'";
  const [deadlines, projects, claudeList, claudeSugg] = await Promise.all([
    q(`SELECT t.*, (SELECT title FROM projects p WHERE p.id = t.project_id) AS project_title FROM tasks t WHERE t.tenant_id = 'owner' AND ${live} AND COALESCE(t.list, 'Tasks') != 'Claude'
       AND t.deadline IS NOT NULL AND t.deadline <= ? AND (t.due_date IS NULL OR t.due_date > ?) ORDER BY t.deadline`, addDays(today, 14), sunday),
    q(`SELECT p.title, p.deadline, a.title AS area_title, (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND ${live}) AS open_count
       FROM projects p LEFT JOIN areas a ON a.id = p.area_id WHERE p.tenant_id = 'owner' AND p.status = 'open' AND p.trashed_at IS NULL ORDER BY a.sort, p.sort, p.title`),
    q(`SELECT title, due_date, notes FROM tasks WHERE tenant_id = 'owner' AND ${live} AND list = 'Claude' ORDER BY due_date IS NULL, due_date, title`),
    q(`SELECT title, reason FROM tasks WHERE tenant_id = 'owner' AND parent_task_id IS NULL AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL AND suggestion_state = 'pending' ORDER BY created_at`),
  ]);
  section('Deadlines in the next 14 days (not already listed above)', deadlines, t => mdLine(t, today));
  section('Projects (open)', projects, p => `- ${String(p.title).replace(/\s+/g, ' ').trim()} (${[p.area_title, p.open_count + ' open', p.deadline ? (p.deadline < today ? `deadline ${p.deadline}, past` : 'deadline ' + p.deadline) : null].filter(Boolean).join('; ')})`);
  const claudeOverdue = claudeList.filter(c => c.due_date && c.due_date < today).length;
  section(`Claude list${claudeOverdue ? ` — ${claudeOverdue} overdue` : ''}`, claudeList, c => `- ${String(c.title).replace(/\s+/g, ' ').trim()}${c.due_date ? ` (${c.due_date < today ? `due ${c.due_date}, ${daysBetween(c.due_date, today)}d overdue` : 'due ' + c.due_date})` : ''}`);
  section('Claude suggestions waiting in Inbox', claudeSugg, c => `- ${String(c.title).replace(/\s+/g, ' ').trim()}${c.reason ? ' — ' + String(c.reason).replace(/\s+/g, ' ').slice(0, 140) : ''}`);
  const done = [...completions.map(c => ({ ...c, recurring: true })), ...doneTasks].sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));
  section('Completed in the last 24h', done, c => `- ${c.priority ? `[${c.priority}] ` : ''}${String(c.title).replace(/\s+/g, ' ').trim()}${c.area ? ` (${c.area})` : ''}${c.recurring ? ' (recurring)' : ''} — ${c.completed_at.slice(0, 16).replace('T', ' ')}Z`);
  section("Won't do (last 24h)", wontDo, w => {
    let p = {};
    try { p = w.props ? JSON.parse(w.props) : {}; } catch (e) { p = {}; }
    const bits = [];
    if (w.area) bits.push(w.area);
    if (w.kind === 'task_skipped') bits.push('skipped one occurrence' + (p.occurrence ? ' (' + p.occurrence + ')' : ''));
    else if (p.series === 'stop') bits.push('stopped series');
    if (w.kind === 'task_dropped' && !w.dropped_at) bits.push('since restored');
    const why = [p.reason && DROP_REASONS[p.reason], p.text].filter(Boolean).join(': ');
    return `- ${w.priority ? `[${w.priority}] ` : ''}${String(w.title).replace(/\s+/g, ' ').trim()}${bits.length ? ' (' + bits.join('; ') + ')' : ''}${why ? ' — ' + why : ''}`;
  });
  section('Pending suggestions', suggestions, s => {
    const bits = [];
    if (s.area) bits.push(s.area);
    if (s.due_date) bits.push('due ' + s.due_date);
    if (s.source) bits.push(s.source_detail ? `${s.source}: ${String(s.source_detail).replace(/\s+/g, ' ').slice(0, 100)}` : s.source);
    return `- ${s.priority ? `[${s.priority}] ` : ''}${String(s.title).replace(/\s+/g, ' ').trim()}${bits.length ? ' (' + bits.join('; ') + ')' : ''}`;
  });
  if (opts.freshness) {
    // Retired sources (superseded collectors, B40) are left out
    const rows = await q('SELECT * FROM source_health WHERE tenant_id = ? AND retired_at IS NULL ORDER BY source', 'owner');
    out.push('## Source freshness');
    if (!rows.length) out.push('_no sources have reported yet_');
    for (const r of rows) {
      const h = healthRow(r);
      out.push(`- ${r.source}: ${h.stale ? 'STALE' : 'ok'}; last ok ${r.last_ok || 'never'}${h.age_hours != null ? ` (${h.age_hours}h ago)` : ''}${r.last_error ? `; last error: ${String(r.last_error).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// Complete a task (recurring tasks advance; others get completed_at). Shared by the app and the agent API.
async function completeTask(env, ctx, taskId, via) {
  const taskStmt = env.DB.prepare('SELECT * FROM tasks WHERE id = ?');
  const taskResult = await taskStmt.bind(taskId).first();

  if (!taskResult) return { notFound: true };

  const isRecurring = !!taskResult.recurrence;

  // v1 repeat rules (completions from the v1 app): next date after max(its date, today), after-completion mode, end conditions
  let v1Next = null;
  if (isRecurring && (via === 'v1' || via === 'device')) {
    const done = (await env.DB.prepare('SELECT COUNT(*) AS n FROM completions WHERE task_id = ?').bind(taskId).first()).n;
    const adv = advanceRepeat(taskResult, getTodayLA(), done);
    if (adv.ended) {
      // the last occurrence: the series is done and the to-do itself goes to the Logbook
      const now = new Date().toISOString();
      await env.DB.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?').bind(now, now, taskId).run();
      emit(env, ctx, 'task_completed', { task_id: taskId, area: taskResult.area, props: { due_date: taskResult.due_date, recurring: true, series_ended: true, via } });
      return { ok: true };
    }
    v1Next = adv;
  }

  if (isRecurring) {
    // Log to completions
    const completionId = generateId();
    const now = new Date().toISOString();
    const today = getTodayLA();

    // Get all steps for snapshot
    const stepsStmt = env.DB.prepare('SELECT * FROM tasks WHERE parent_task_id = ?');
    const stepsResult = await stepsStmt.bind(taskId).all();
    const snapshot = JSON.stringify({
      dueDate: taskResult.due_date,
      snoozedFrom: taskResult.snoozed_from,
      steps: (stepsResult.results || []).map(s => ({
        id: s.id,
        completedAt: s.completed_at,
      })),
    });

    // Insert completion record
    const completionStmt = env.DB.prepare(
      'INSERT INTO completions (id, tenant_id, task_id, due_date, completed_at, snapshot) VALUES (?, ?, ?, ?, ?, ?)'
    );
    await completionStmt.bind(completionId, 'owner', taskId, taskResult.due_date, now, snapshot).run();

    // Advance due_date from base (snoozed_from or original due_date); v1 uses its rule engine
    let base = taskResult.snoozed_from || taskResult.due_date;
    let nextDueDate = v1Next ? v1Next.next : advanceDueDate(base, taskResult.recurrence);
    while (!v1Next && nextDueDate <= taskResult.due_date) {
      nextDueDate = advanceDueDate(nextDueDate, taskResult.recurrence);
    }
    if (v1Next) await env.DB.prepare('UPDATE tasks SET repeat_rule = ? WHERE id = ?').bind(JSON.stringify(v1Next.rule), taskId).run();

    // Reset all steps' completed_at to NULL
    const resetStepsStmt = env.DB.prepare('UPDATE tasks SET completed_at = NULL WHERE parent_task_id = ?');
    await resetStepsStmt.bind(taskId).run();

    // Update task due_date, clear snoozed_from, keep completed_at NULL
    const updateStmt = env.DB.prepare(
      'UPDATE tasks SET due_date = ?, snoozed_from = NULL, updated_at = ? WHERE id = ?'
    );
    await updateStmt.bind(nextDueDate, now, taskId).run();
  } else {
    // Non-recurring: just set completed_at
    const now = new Date().toISOString();
    const updateStmt = env.DB.prepare('UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?');
    await updateStmt.bind(now, now, taskId).run();
  }

  if (taskResult.inbox && !taskResult.due_date) emit(env, ctx, 'inbox_triaged', { task_id: taskId, area: taskResult.area, props: { to: 'done', ...(via ? { via } : {}) } });
  if (!taskResult.parent_task_id) {
    const todayLA = getTodayLA();
    const late = !!taskResult.due_date && taskResult.due_date < todayLA;
    emit(env, ctx, 'task_completed', {
      task_id: taskId, area: taskResult.area,
      props: {
        due_date: taskResult.due_date, late,
        days_late: late ? daysBetween(taskResult.due_date, todayLA) : 0,
        recurring: isRecurring,
        ...(via ? { via } : {}),
      },
    });
  }

  return { ok: true };
}

// Undo a completion: recurring tasks go back to the date (and step states) saved in their last completion; others clear completed_at.
async function uncompleteTask(env, ctx, taskId, via) {
  const taskStmt = env.DB.prepare('SELECT * FROM tasks WHERE id = ?');
  const taskResult = await taskStmt.bind(taskId).first();

  if (!taskResult) return { notFound: true };

  const now = new Date().toISOString();
  const isRecurring = !!taskResult.recurrence;

  if (isRecurring && !taskResult.completed_at) {
    // Get the most recent completion
    const completionStmt = env.DB.prepare(
      'SELECT * FROM completions WHERE task_id = ? ORDER BY completed_at DESC LIMIT 1'
    );
    const completion = await completionStmt.bind(taskId).first();

    if (completion && completion.snapshot) {
      const snapshot = JSON.parse(completion.snapshot);

      // Restore previous due_date and snoozed_from
      const restoreDueStmt = env.DB.prepare('UPDATE tasks SET due_date = ?, snoozed_from = ? WHERE id = ?');
      await restoreDueStmt.bind(snapshot.dueDate, snapshot.snoozedFrom || null, taskId).run();

      // Restore step states
      if (snapshot.steps && snapshot.steps.length > 0) {
        for (const step of snapshot.steps) {
          const restoreStepStmt = env.DB.prepare('UPDATE tasks SET completed_at = ? WHERE id = ?');
          await restoreStepStmt.bind(step.completedAt, step.id).run();
        }
      }

      // Delete the completion record
      const deleteStmt = env.DB.prepare('DELETE FROM completions WHERE id = ?');
      await deleteStmt.bind(completion.id).run();
    }
  } else if (!isRecurring || taskResult.completed_at) {
    // Non-recurring (or a finished series): just clear completed_at
    const updateStmt = env.DB.prepare('UPDATE tasks SET completed_at = NULL WHERE id = ?');
    await updateStmt.bind(taskId).run();
  }

  const updateTaskStmt = env.DB.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?');
  await updateTaskStmt.bind(now, taskId).run();
  if (!taskResult.parent_task_id) emit(env, ctx, 'task_uncompleted', { task_id: taskId, area: taskResult.area, props: { recurring: isRecurring, ...(via ? { via } : {}) } });

  return { ok: true };
}

// Partial task update; returns a Response. Shared by the app and the agent API.
async function patchTask(env, ctx, taskId, body, via) {
  const result = validateTaskPatch(body);
  if (result.error) return json({ error: result.error }, 400);
  const fields = result.fields;

  const existing = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!existing) return json({ error: 'Task not found' }, 404);
  const compat = await syncCompat(env, fields, body, existing);
  if (compat.error) return json({ error: compat.error }, 400);
  // Setting a repeat on an undated to-do starts it today
  if (fields.recurrence && !('due_date' in fields ? fields.due_date : existing.due_date)) { fields.due_date = getTodayLA(); fields.inbox = 0; fields.start = null; }
  if ('due_date' in fields && fields.due_date === null && ('recurrence' in fields ? fields.recurrence : existing.recurrence)) {
    return json({ error: 'Recurring tasks need a due date (remove the repeat first)' }, 400);
  }

  // Inbox: a date or an explicit move to the backlog takes a task out of the Inbox
  const leftInbox = existing.inbox && 'due_date' in fields && !fields.inbox;
  if (leftInbox) fields.inbox = 0;

  // Manually setting a new due date replaces any snooze memory
  if ('due_date' in fields && fields.due_date !== existing.due_date) fields.snoozed_from = null;

  const now = new Date().toISOString();
  const cols = Object.keys(fields);
  const sql = 'UPDATE tasks SET ' + cols.map(c => c + ' = ?').join(', ') + (cols.length ? ', ' : '') + 'updated_at = ? WHERE id = ?';
  await env.DB.batch([env.DB.prepare(sql).bind(...cols.map(c => fields[c]), now, taskId), ...extrasStmts(env, taskId, result.extras || {})]);
  if (fields.suggestion_state && fields.suggestion_state !== existing.suggestion_state) emit(env, ctx, 'suggestion_' + fields.suggestion_state, { task_id: taskId, props: { via: via || 'app' } });

  const updated = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();

  if (leftInbox) emit(env, ctx, 'inbox_triaged', { task_id: taskId, area: updated.area, props: { to: fields.due_date ? 'date' : 'backlog', via: via || 'app' } });
  const changed = cols.filter(c => c !== 'snoozed_from' && c !== 'inbox' && (fields[c] ?? null) !== (existing[c] ?? null));
  if (changed.length) {
    const props = { fields: changed };
  if (via) props.via = via;
    if (changed.includes('due_date')) { props.from = existing.due_date; props.to = fields.due_date; props.rescheduled = true; }
    if (changed.includes('priority')) { props.priority_from = existing.priority || null; props.priority_to = fields.priority; }
    if (changed.includes('area')) { props.area_from = existing.area || null; props.area_to = fields.area; }
    emit(env, ctx, 'task_edited', { task_id: taskId, area: updated.area, props });
    if (changed.includes('priority')) emit(env, ctx, 'task_priority', { task_id: taskId, area: updated.area, props: { from: existing.priority || null, to: fields.priority, via: via || 'edit' } });
    if (changed.includes('due_date') && fields.due_date === null) emit(env, ctx, 'task_backlogged', { task_id: taskId, area: updated.area, props: { from: existing.due_date, via: via || 'app' } });
    if (changed.includes('due_date') && existing.due_date === null && fields.due_date) emit(env, ctx, 'task_scheduled', { task_id: taskId, area: updated.area, props: { to: fields.due_date, via: via || 'app' } });
  }
  return json(updated);
}


// ---- Task signals (B28 why-later, B29 outcome, B30 won't do, B4 completed today) ----

// Latest event of the given kinds for a task in the last day (the action a signal explains)
async function latestTaskEvent(env, taskId, kinds, extraSql = '') {
  const since = new Date(Date.now() - 86400000).toISOString();
  return env.DB.prepare(
    `SELECT id, kind, props FROM events WHERE task_id = ? AND at >= ? AND kind IN (${kinds.map(() => '?').join(',')}) ${extraSql} ORDER BY at DESC LIMIT 1`
  ).bind(taskId, since, ...kinds).first();
}

// Add reason fields to an existing event; if there is none, log a task_reason event instead. Never throws.
async function attachToEvent(env, ctx, ev, task, extra) {
  try {
    if (ev) {
      await env.DB.prepare('UPDATE events SET props = ? WHERE id = ?').bind(mergeProps(ev.props, extra), ev.id).run();
      return;
    }
  } catch (e) { console.error('event reason update failed', String(e)); }
  emit(env, ctx, 'task_reason', { task_id: task.id, area: task.area, props: extra });
}

// Won't do: one-off (or recurring + series 'stop') gets dropped_at; recurring + series 'skip' advances to the next occurrence.
// opts: { reason?, text?, series? }. Returns { ok, task, previous? } or { notFound } or { error, status }.
async function dropTask(env, ctx, taskId, opts, via) {
  const o = opts || {};
  const r = normalizeReason(o.reason, DROP_REASONS);
  if (r.error) return { error: r.error };
  const t = cleanText(o.text, 200);
  if (t.error) return { error: t.error };
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return { notFound: true };
  if (task.parent_task_id) return { error: 'Steps cannot be marked won\'t do' };
  if (task.dropped_at) return { error: 'Already marked won\'t do', status: 409 };
  if (task.completed_at) return { error: 'Task is already completed', status: 409 };
  const recurring = !!task.recurrence;
  if (recurring && !['skip', 'stop'].includes(o.series)) return { error: "Recurring task: series must be 'skip' (this occurrence) or 'stop' (the series)" };
  const series = recurring ? o.series : null;

  const today = getTodayLA();
  const now = new Date().toISOString();
  const label = r.code ? DROP_REASONS[r.code] : null;
  const hasReason = !!(label || t.text);
  const reasonProps = { reason: r.code, text: t.text, ...(via ? { via } : {}) };

  if (series === 'skip') {
    if (!task.due_date) return { error: 'Recurring task has no due date' };
    const occurrence = task.snoozed_from || task.due_date;
    let next;
    if (via === 'v1') { const adv = advanceRepeat(task, today, 0); next = adv.next; }
    else { next = advanceDueDate(occurrence, task.recurrence); while (next <= task.due_date) next = advanceDueDate(next, task.recurrence); }
    const notes = hasReason ? appendNoteLine(task.notes, signalLine('wont_do', { today, label, text: t.text, detail: 'skipped ' + shortDate(occurrence, today) })) : task.notes;
    await env.DB.prepare('UPDATE tasks SET due_date = ?, snoozed_from = NULL, notes = ?, updated_at = ? WHERE id = ?').bind(next, notes, now, taskId).run();
    emit(env, ctx, 'task_skipped', { task_id: taskId, area: task.area, props: { from: task.due_date, to: next, occurrence, ...reasonProps } });
    const updated = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
    return { ok: true, task: updated, skipped: true, previous: { due_date: task.due_date, snoozed_from: task.snoozed_from || null } };
  }

  const notes = hasReason ? appendNoteLine(task.notes, signalLine('wont_do', { today, label, text: t.text, detail: series === 'stop' ? 'stopped series' : null })) : task.notes;
  await env.DB.prepare('UPDATE tasks SET dropped_at = ?, notes = ?, updated_at = ? WHERE id = ?').bind(now, notes, now, taskId).run();
  const late = !!task.due_date && task.due_date < today;
  emit(env, ctx, 'task_dropped', { task_id: taskId, area: task.area, props: { due_date: task.due_date, late, recurring, ...(series ? { series } : {}), ...reasonProps } });
  if (task.inbox && !task.due_date) emit(env, ctx, 'inbox_triaged', { task_id: taskId, area: task.area, props: { to: 'dropped', ...(via ? { via } : {}) } });
  const updated = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  return { ok: true, task: updated };
}

// Undo Won't do: clears dropped_at, or (opts.due_date) puts a skipped recurring task back on its old date.
async function restoreTask(env, ctx, taskId, opts, via) {
  const o = opts || {};
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return { notFound: true };
  const today = getTodayLA();
  const now = new Date().toISOString();
  const notes = endsWithWontDo(task.notes) ? appendNoteLine(task.notes, signalLine('restored', { today })) : task.notes;
  if (task.dropped_at) {
    await env.DB.prepare('UPDATE tasks SET dropped_at = NULL, notes = ?, updated_at = ? WHERE id = ?').bind(notes, now, taskId).run();
    emit(env, ctx, 'task_restored', { task_id: taskId, area: task.area, props: { from: 'dropped', dropped_at: task.dropped_at, ...(via ? { via } : {}) } });
  } else if (o.due_date !== undefined) {
    if (!task.recurrence) return { error: 'Only a skipped recurring task can be restored to a date' };
    if (!isValidDate(o.due_date)) return { error: 'Invalid due_date' };
    if (o.snoozed_from != null && !isValidDate(o.snoozed_from)) return { error: 'Invalid snoozed_from' };
    await env.DB.prepare('UPDATE tasks SET due_date = ?, snoozed_from = ?, notes = ?, updated_at = ? WHERE id = ?').bind(o.due_date, o.snoozed_from || null, notes, now, taskId).run();
    emit(env, ctx, 'task_restored', { task_id: taskId, area: task.area, props: { from: 'skipped', due_from: task.due_date, due_to: o.due_date, ...(via ? { via } : {}) } });
  } else {
    return { error: 'Task is not marked won\'t do', status: 409 };
  }
  return { ok: true, task: await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first() };
}

// App: answer to a prompt after the action is saved. body { kind: 'later'|'outcome', reason?, text? }
async function recordSignal(env, ctx, taskId, body) {
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);
  const task = await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(taskId).first();
  if (!task) return json({ error: 'Task not found' }, 404);
  const today = getTodayLA();
  let line, ev, extra;
  if (body.kind === 'later') {
    const r = normalizeReason(body.reason, LATER_REASONS);
    if (r.error) return json({ error: r.error }, 400);
    const t = cleanText(body.text, 200);
    if (t.error) return json({ error: t.error }, 400);
    if (!r.code && !t.text) return json({ error: 'Nothing to record' }, 400);
    ev = await latestTaskEvent(env, taskId, ['task_snoozed', 'task_edited'], "AND (kind = 'task_snoozed' OR json_extract(props, '$.rescheduled') = 1)");
    let to = task.due_date;
    try { const p = ev && ev.props ? JSON.parse(ev.props) : null; if (p && p.to) to = p.to; } catch (e) { /* keep task due date */ }
    line = signalLine(ev && ev.kind === 'task_edited' ? 'moved' : 'snoozed', { today, to, label: r.code ? LATER_REASONS[r.code] : null, text: t.text });
    extra = { reason: r.code, text: t.text };
  } else if (body.kind === 'outcome') {
    const t = cleanText(body.text, 500);
    if (t.error) return json({ error: t.error }, 400);
    if (!t.text) return json({ error: 'Nothing to record' }, 400);
    ev = await latestTaskEvent(env, taskId, ['task_completed']);
    line = signalLine('done', { today, text: t.text });
    extra = { outcome: t.text };
  } else {
    return json({ error: "kind must be 'later' or 'outcome'" }, 400);
  }
  const notes = appendNoteLine(task.notes, line);
  await env.DB.prepare('UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?').bind(notes, new Date().toISOString(), taskId).run();
  await attachToEvent(env, ctx, ev, task, { for: body.kind, ...extra });
  return json({ ok: true, line });
}

// B4: what was finished today (LA): recurring check-offs from the completions log + one-off tasks with completed_at
async function completedToday(env) {
  const today = getTodayLA();
  const since = new Date(Date.now() - 36 * 3600000).toISOString();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
  const [rec, oneOff] = await Promise.all([
    q(`SELECT c.id AS completion_id, c.task_id, c.completed_at, t.title, t.priority, t.area FROM completions c JOIN tasks t ON t.id = c.task_id
       WHERE c.tenant_id = 'owner' AND c.completed_at >= ? AND t.parent_task_id IS NULL ORDER BY c.completed_at DESC`, since),
    q(`SELECT id AS task_id, completed_at, title, priority, area FROM tasks
       WHERE tenant_id = 'owner' AND parent_task_id IS NULL AND completed_at IS NOT NULL AND completed_at >= ? ORDER BY completed_at DESC`, since),
  ]);
  const seen = new Set();
  const out = [];
  for (const c of rec) {
    if (laDateOf(c.completed_at) !== today) continue;
    // Undo restores the latest completion only, so only the newest one per task gets the button
    out.push({ ...c, recurring: true, can_undo: !seen.has(c.task_id) });
    seen.add(c.task_id);
  }
  for (const t of oneOff) if (laDateOf(t.completed_at) === today) out.push({ ...t, recurring: false, can_undo: true });
  out.sort((a, b) => (a.completed_at < b.completed_at ? 1 : -1));
  return out;
}

async function droppedRecent(env, days) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const r = await env.DB.prepare(
    `SELECT id, title, priority, area, list, due_date, recurrence, notes, dropped_at FROM tasks
     WHERE tenant_id = 'owner' AND parent_task_id IS NULL AND dropped_at IS NOT NULL AND dropped_at >= ? ORDER BY dropped_at DESC LIMIT 200`
  ).bind(since).all();
  return r.results || [];
}

// ---- Agent API (/api/agent/*): Bearer AGENT_KEY only, no cookie ----
const SUGGESTION_SOURCES = ['Gmail', 'Calendar', 'Messages', 'Messenger', 'WhatsApp'];
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const clip = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));

// Agent auth: 'full' for AGENT_KEY, 'ingest' for INGEST_KEY (collectors: may only POST ingest/health), else null
async function agentScope(request, env) {
  const m = (request.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const sha = async (x) => new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(x)));
  const same = async (key) => {
    if (!key) return false;
    const [a, b] = await Promise.all([sha(m[1]), sha(key)]);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  };
  if (await same(env.AGENT_KEY)) return 'full';
  if (await same(env.INGEST_KEY)) return 'ingest';
  return null;
}
const INGEST_SCOPE_ROUTES = new Set(['POST /api/agent/ingest', 'POST /api/agent/health', 'POST /api/agent/items/attachment', 'GET /api/agent/items/attachment/pending']);

function healthRow(r) {
  const lastOk = r.last_ok ? Date.parse(r.last_ok) : NaN;
  const hrs = r.stale_after_hours ?? 12;
  const age = isNaN(lastOk) ? null : Math.round((Date.now() - lastOk) / 360000) / 10;
  return {
    source: r.source, last_ok: r.last_ok, last_attempt: r.last_attempt, last_error: r.last_error,
    stale_after_hours: hrs, age_hours: age, stale: !r.retired_at && (age === null || age > hrs),
    ...(r.retired_at ? { retired_at: r.retired_at } : {}),
  };
}

function itemOut(r) {
  let meta = null;
  if (r.meta) { try { meta = JSON.parse(r.meta); } catch (e) { meta = null; } }
  let prev = null;
  if (r.prev) { try { prev = JSON.parse(r.prev); } catch (e) { prev = null; } }
  return { ...r, unread: r.unread === null ? null : !!r.unread, needs_reply: r.needs_reply === null ? null : !!r.needs_reply, meta, prev };
}

const flag = (v) => (v === undefined || v === null ? null : (v === true || v === 1 || v === '1' ? 1 : 0));

// SQL fragment: column matches title (case-insensitive equal, or one starts with the other's first 18 chars). Same rule as scripts/post-brief.py.
const similarSql = (col) => `(lower(${col}) = ? OR instr(?, substr(lower(${col}), 1, 18)) = 1 OR instr(lower(${col}), ?) = 1)`;

// B35: optional snapshot { source, window_start, window_end, complete } -> { start, end, complete } or { error }
function parseSnapshot(snap, source) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return { error: 'snapshot must be an object' };
  if (snap.source !== undefined && snap.source !== source) return { error: 'snapshot.source must match source' };
  const a = Date.parse(snap.window_start), b = Date.parse(snap.window_end);
  if (typeof snap.window_start !== 'string' || typeof snap.window_end !== 'string' || isNaN(a) || isNaN(b)) return { error: 'snapshot.window_start/window_end must be ISO 8601' };
  if (a >= b) return { error: 'snapshot.window_start must be before window_end' };
  if (snap.complete !== undefined && typeof snap.complete !== 'boolean') return { error: 'snapshot.complete must be boolean' };
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString(), complete: snap.complete === true };
}

async function agentIngest(env, ctx, body) {
  const source = body && body.source;
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return json({ error: 'Invalid source (1-40 chars: letters, digits, _ . -)' }, 400);
  if (!Array.isArray(body.items)) return json({ error: 'items must be an array' }, 400);
  if (body.items.length > 500) return json({ error: 'Max 500 items per request' }, 400);
  let snap = null;
  if (body.snapshot !== undefined && body.snapshot !== null) {
    snap = parseSnapshot(body.snapshot, source);
    if (snap.error) return json({ error: snap.error }, 400);
  }
  const nowIso = new Date().toISOString();
  const byId = new Map();
  const errors = [];
  body.items.forEach((it, i) => {
    if (!it || typeof it !== 'object' || typeof it.ext_id !== 'string' || !it.ext_id || it.ext_id.length > 200) { errors.push({ index: i, error: 'Invalid ext_id' }); return; }
    const t = Date.parse(it.ts);
    if (isNaN(t)) { errors.push({ index: i, error: 'Invalid ts (ISO 8601 required)' }); return; }
    let meta = null;
    if (it.meta !== undefined && it.meta !== null) {
      meta = JSON.stringify(it.meta);
      if (meta.length > 2000) { errors.push({ index: i, error: 'meta too large (max 2000 chars JSON)' }); return; }
    }
    byId.set(it.ext_id, [
      it.ext_id, new Date(t).toISOString(), clip(it.who, 120), clip(it.title, 200), clip(it.snippet, 300),
      flag(it.unread), flag(it.needs_reply), meta,
    ]);
  });
  const ids = [...byId.keys()];
  const existing = new Map(); // ext_id -> stored row
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await env.DB.prepare(`SELECT ext_id, ts, title, snippet, removed_at FROM items WHERE tenant_id = 'owner' AND source = ? AND ext_id IN (${chunk.map(() => '?').join(',')})`).bind(source, ...chunk).all();
    for (const row of r.results || []) existing.set(row.ext_id, row);
  }
  // A re-sighted item is no longer removed. prev is only written by a snapshot diff (B35).
  const upsert = env.DB.prepare(
    `INSERT INTO items (id, tenant_id, source, ext_id, ts, who, title, snippet, unread, needs_reply, meta, first_seen, last_seen)
     VALUES (?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, source, ext_id) DO UPDATE SET ts = excluded.ts, who = COALESCE(excluded.who, who), title = COALESCE(excluded.title, title),
       snippet = COALESCE(excluded.snippet, snippet), unread = COALESCE(excluded.unread, unread), needs_reply = COALESCE(excluded.needs_reply, needs_reply),
       meta = COALESCE(excluded.meta, meta), last_seen = excluded.last_seen, removed_at = NULL`
  );
  const stmts = [...byId.values()].map(v => upsert.bind('i-' + generateId(), source, v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], nowIso, nowIso));

  // B35: diff against what was stored, when the batch is a snapshot of a window
  let diff = null;
  if (snap) {
    diff = { added: [], changed: [], removed: [] };
    for (const [extId, v] of byId) {
      const old = existing.get(extId);
      if (!old || old.removed_at) { diff.added.push(extId); continue; }
      // Omitted title/snippet keep the stored value (same as the upsert), so they don't count as a change
      const after = { ts: v[1], title: v[3] ?? old.title, snippet: v[4] ?? old.snippet };
      const before = { ts: old.ts, title: old.title, snippet: old.snippet };
      if (after.ts !== before.ts || after.title !== before.title || after.snippet !== before.snippet) {
        diff.changed.push({ ext_id: extId, before, after });
        stmts.push(env.DB.prepare("UPDATE items SET prev = ? WHERE tenant_id = 'owner' AND source = ? AND ext_id = ?")
          .bind(JSON.stringify({ ...before, changed_at: nowIso }), source, extId));
      }
    }
    // Removals need complete:true (a failed gather must not wipe the window) and a clean batch (a rejected item is not gone)
    if (!snap.complete) diff.removals_skipped = 'snapshot.complete is not true';
    else if (errors.length) diff.removals_skipped = 'some items were rejected';
    else {
      const inWindow = await env.DB.prepare(
        "SELECT ext_id FROM items WHERE tenant_id = 'owner' AND source = ? AND removed_at IS NULL AND ts >= ? AND ts < ?"
      ).bind(source, snap.start, snap.end).all();
      for (const row of inWindow.results || []) {
        if (byId.has(row.ext_id)) continue;
        diff.removed.push(row.ext_id);
        stmts.push(env.DB.prepare("UPDATE items SET removed_at = ? WHERE tenant_id = 'owner' AND source = ? AND ext_id = ?").bind(nowIso, source, row.ext_id));
      }
    }
  }
  stmts.push(env.DB.prepare(
    `INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error) VALUES ('owner', ?, ?, ?, NULL)
     ON CONFLICT(tenant_id, source) DO UPDATE SET last_ok = excluded.last_ok, last_attempt = excluded.last_attempt, last_error = NULL`
  ).bind(source, nowIso, nowIso));
  for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
  // chat media descriptions live in the snippet; a re-sent item carries the collector's plain tags, so put them back
  try { await reapplySnippets(env, source, ids); } catch (e) { console.error('snippet reapply failed', String(e)); }
  const updated = ids.filter(x => existing.has(x)).length;
  const out = { inserted: ids.length - updated, updated };
  if (errors.length) out.rejected = errors;
  if (diff) {
    Object.assign(out, diff);
    emit(env, ctx, 'calendar_diff', { props: { source, window_start: snap.start, window_end: snap.end, complete: snap.complete,
      added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, ...(diff.removals_skipped ? { removals_skipped: true } : {}) } });
  }
  return json(out);
}

async function agentHealthPost(env, body) {
  const source = body && body.source;
  if (typeof source !== 'string' || !SOURCE_RE.test(source)) return json({ error: 'Invalid source' }, 400);
  if (typeof body.ok !== 'boolean') return json({ error: 'ok must be boolean' }, 400);
  let stale = null;
  if (body.stale_after_hours !== undefined) {
    if (!Number.isInteger(body.stale_after_hours) || body.stale_after_hours < 1 || body.stale_after_hours > 720) return json({ error: 'stale_after_hours must be an integer 1-720' }, 400);
    stale = body.stale_after_hours;
  }
  const nowIso = new Date().toISOString();
  const err = body.ok ? null : (clip(body.error, 300) || 'unknown error');
  await env.DB.prepare(
    `INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error, stale_after_hours) VALUES ('owner', ?, ?, ?, ?, COALESCE(?, 12))
     ON CONFLICT(tenant_id, source) DO UPDATE SET last_ok = COALESCE(excluded.last_ok, last_ok), last_attempt = excluded.last_attempt,
       last_error = excluded.last_error, stale_after_hours = COALESCE(?, stale_after_hours)`
  ).bind(source, body.ok ? nowIso : null, nowIso, err, stale, stale).run();
  const row = await env.DB.prepare("SELECT * FROM source_health WHERE tenant_id = 'owner' AND source = ?").bind(source).first();
  return json(healthRow(row));
}

async function agentBrief(env, body) {
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);
  const { date, body_md } = body;
  if (!isValidDate(date)) return json({ error: 'Invalid date (YYYY-MM-DD)' }, 400);
  if (typeof body_md !== 'string' || !body_md || body_md.length > 20000) return json({ error: 'Invalid body_md (1-20000 chars)' }, 400);
  const suggestions = body.suggestions === undefined ? [] : body.suggestions;
  if (!Array.isArray(suggestions)) return json({ error: 'suggestions must be an array' }, 400);
  const now = new Date().toISOString().slice(0, 19) + 'Z';
  const stmts = [
    env.DB.prepare("DELETE FROM briefs WHERE tenant_id = 'owner' AND date = ?").bind(date),
    env.DB.prepare("DELETE FROM suggestions WHERE tenant_id = 'owner' AND brief_date = ? AND status = 'pending'").bind(date),
    env.DB.prepare("INSERT INTO briefs (id, tenant_id, date, body_md, created_at) VALUES (?, 'owner', ?, ?, ?)").bind('b-' + generateId(), date, body_md, now),
  ];
  const skipped = [];
  const suggStart = stmts.length;
  suggestions.forEach((sg, i) => {
    const bad = (e) => skipped.push({ index: i, title: sg && sg.title, error: e });
    if (!sg || typeof sg !== 'object') return bad('not an object');
    const { title, due_date, priority, recurrence, source, source_detail, area } = sg;
    const list = sg.list || 'Tasks';
    if (!title || typeof title !== 'string' || title.length > 200) return bad('Invalid title');
    if (due_date && !isValidDate(due_date)) return bad('Invalid due_date');
    if (priority && !['P0', 'P1', 'P2', 'P3'].includes(priority)) return bad('Invalid priority');
    if (!['Tasks', 'Birthdays'].includes(list)) return bad('Invalid list');
    if (recurrence && !['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(recurrence)) return bad('Invalid recurrence');
    if (source && !SUGGESTION_SOURCES.includes(source)) return bad('Invalid source');
    if (source_detail && (typeof source_detail !== 'string' || source_detail.length > 300)) return bad('Invalid source_detail (max 300)');
    if (area && !AREAS.includes(area)) return bad('Invalid area');
    const t = title.toLowerCase(), head = t.slice(0, 18);
    // Dedupe guard: skip if it matches an open task, or a suggestion decided (non-pending) in the last 14 days
    stmts.push(env.DB.prepare(
      `INSERT INTO suggestions (id, tenant_id, brief_date, title, due_date, priority, list, recurrence, source, source_detail, area, status, created_at)
       SELECT ?, 'owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?
       WHERE NOT EXISTS (SELECT 1 FROM tasks t WHERE t.completed_at IS NULL AND ${similarSql('t.title')})
       AND NOT EXISTS (SELECT 1 FROM suggestions x WHERE x.status != 'pending' AND x.created_at >= datetime('now', '-14 day') AND ${similarSql('x.title')})`
    ).bind('s-' + generateId(), date, title, due_date || null, priority || null, list, recurrence || null, source || null, source_detail || null, area || null, now,
      t, t, head, t, t, head));
  });
  const res = await env.DB.batch(stmts);
  const inserted = res.slice(suggStart).reduce((n, r) => n + (r.meta && r.meta.changes ? 1 : 0), 0);
  const attempted = stmts.length - suggStart;
  return json({ ok: true, date, briefs: 1, suggestions_inserted: inserted, suggestions_deduped: attempted - inserted, suggestions_skipped_invalid: skipped });
}

// Every task gets a priority (product decision): unspecified = P2 (should happen; date can slide)
const DEFAULT_PRIORITY = 'P2';

async function agentTaskCreate(env, ctx, body) {
  if (!body || typeof body !== 'object') return json({ error: 'Invalid body' }, 400);
  const { title, list, recurrence, priority } = body;
  const due_date = body.due_date || null;
  const v = validateTaskFields(title, list, due_date, recurrence, priority);
  if (!v.valid) return json({ error: v.error }, 400);
  if (due_date && !isValidDate(due_date)) return json({ error: 'Invalid due_date' }, 400);
  if (body.notes != null && (typeof body.notes !== 'string' || body.notes.length > 10000)) return json({ error: 'Invalid notes' }, 400);
  const area = body.area || null;
  if (area !== null && !AREAS.includes(area)) return json({ error: 'Invalid area' }, 400);
  if (body.ask_outcome !== undefined && ![true, false, 0, 1].includes(body.ask_outcome)) return json({ error: 'Invalid ask_outcome (boolean)' }, 400);
  const askOutcome = body.ask_outcome === true || body.ask_outcome === 1 ? 1 : 0;
  const notes = body.notes && body.notes.trim() ? body.notes : null;
  if (body.backlog !== undefined && body.backlog !== true && body.backlog !== false) return json({ error: 'backlog must be boolean' }, 400);
  const backlog = body.backlog === true;
  if (backlog && (due_date || recurrence)) return json({ error: 'A backlog task has no due_date or recurrence' }, 400);
  // v1 fields (start, evening, deadline, flagged, place, repeat, checklist, tags; source/reason = a Claude suggestion)
  const v1 = validateV1(body, { creating: true });
  if (v1.error) return json({ error: v1.error }, 400);
  const v1f = v1.fields;
  if ('area' in body && !('area_id' in v1f)) v1f.area = area;
  const compat = await syncCompat(env, v1f, body, null);
  if (compat.error) return json({ error: compat.error }, 400);
  if (v1f.source === 'claude') {
    const dup = await suggestionDuplicate(env, title);
    if (dup) return json({ error: `Similar to-do ${dup.why === 'open' ? 'is already open' : 'was dismissed in the last 14 days'}`, duplicate_of: dup.id }, 409);
  }
  const id = 't-' + generateId().slice(0, 8);
  const now = new Date().toISOString();
  const finalDue = 'due_date' in v1f ? v1f.due_date : (backlog ? null : (due_date || getTodayLA()));
  if (backlog && !('start' in v1f)) v1f.start = 'someday';
  if (!('created_via' in v1f)) v1f.created_via = 'agent';
  await env.DB.prepare(
    'INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, notes, area, ask_outcome, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, 'owner', list || 'Tasks', title.trim(), priority || DEFAULT_PRIORITY, finalDue, recurrence || null, notes, 'area' in v1f ? v1f.area : area, askOutcome, now, now).run();
  // v1 columns in one follow-up update (keeps the v0 insert unchanged)
  const v1cols = Object.keys(v1f).filter(k => !['due_date', 'area', 'recurrence', 'priority'].includes(k) || (k === 'recurrence' && v1f.recurrence && !recurrence));
  const upd = [];
  if (v1cols.length) upd.push(env.DB.prepare(`UPDATE tasks SET ${v1cols.map(c => c + ' = ?').join(', ')} WHERE id = ?`).bind(...v1cols.map(c => v1f[c]), id));
  if (!('repeat_rule' in v1f) && recurrence) upd.push(env.DB.prepare('UPDATE tasks SET repeat_rule = ? WHERE id = ?').bind(JSON.stringify(recurrence === 'weekdays' ? { mode: 'schedule', freq: 'weekly', interval: 1, byweekday: [1, 2, 3, 4, 5] } : { mode: 'schedule', freq: recurrence, interval: 1 }), id));
  if (!('flagged' in v1f) && priority === 'P0' && !recurrence && !v1f.recurrence) upd.push(env.DB.prepare('UPDATE tasks SET flagged = 1 WHERE id = ?').bind(id));
  upd.push(...extrasStmts(env, id, v1.extras));
  if (upd.length) await env.DB.batch(upd);
  emit(env, ctx, 'task_created', { task_id: id, area, props: { list: list || 'Tasks', priority: priority || DEFAULT_PRIORITY, due_date: finalDue, recurrence: recurrence || null, ask_outcome: !!askOutcome, via: 'agent' } });
  if (v1f.source === 'claude') emit(env, ctx, 'suggestion_created', { task_id: id, props: {} });
  if (backlog) emit(env, ctx, 'task_backlogged', { task_id: id, area, props: { via: 'agent', created: true } });
  return json(await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first(), 201);
}

// B42: weekly theme (Monday-start weeks, LA dates)
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 86400000).toISOString().slice(0, 10);
}
const THEME_FIELDS = { work_title: 120, work_line: 300, personal_title: 120, personal_line: 300, through_line: 300 };
function themeOut(r) {
  if (!r) return null;
  const out = { week_start: r.week_start, updated_at: r.updated_at };
  for (const k of Object.keys(THEME_FIELDS)) out[k] = r[k] ?? null;
  return out;
}
async function currentTheme(env) {
  const week = mondayOf(getTodayLA());
  return themeOut(await env.DB.prepare("SELECT * FROM weekly_theme WHERE tenant_id = 'owner' AND week_start = ?").bind(week).first());
}

async function handleAgent(request, env, ctx, url, path) {
  const method = request.method;
  const readBody = async () => { try { return await request.json(); } catch (e) { return undefined; } };
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then(r => r.results || []);
  const bad = () => json({ error: 'Invalid JSON' }, 400);

  // Chat images (media.js): upload with the ingest key; agent-only reads
  if (path === '/api/agent/items/attachment' && method === 'POST') return uploadItemMedia(env, request, url, { generateId, emit, ctx });
  if (path === '/api/agent/items/attachment/pending' && method === 'GET') return pendingMedia(env);
  let mm = path.match(/^\/api\/agent\/items\/([A-Za-z0-9_-]+)\/attachments$/);
  if (mm && method === 'GET') return listItemMedia(env, mm[1]);
  mm = path.match(/^\/api\/agent\/attachments\/([A-Za-z0-9_-]+)$/);
  if (mm && method === 'PATCH') return noteItemMedia(env, ctx, mm[1], request, { emit });
  mm = path.match(/^\/api\/agent\/attachments\/([A-Za-z0-9_-]+)\/raw$/);
  if (mm && method === 'GET') return rawItemMedia(env, mm[1], url);
  if (path === '/api/agent/ingest' && method === 'POST') { const b = await readBody(); return b === undefined ? bad() : agentIngest(env, ctx, b); }
  if (path === '/api/agent/health' && method === 'POST') { const b = await readBody(); return b === undefined ? bad() : agentHealthPost(env, b); }
  if (path === '/api/agent/health' && method === 'GET') {
    const all = url.searchParams.get('include_retired') === '1';
    const rows = await q(`SELECT * FROM source_health WHERE tenant_id = 'owner'${all ? '' : ' AND retired_at IS NULL'} ORDER BY source`);
    return json({ now: new Date().toISOString(), sources: rows.map(healthRow), cursors: await cursorHealth(env) });
  }
  // B40: retire or restore a source's health row (hidden from health and snapshot freshness while retired)
  if (path === '/api/agent/health/retire' && method === 'POST') {
    const b = await readBody();
    if (!b || typeof b.source !== 'string' || !SOURCE_RE.test(b.source) || typeof b.retired !== 'boolean') return json({ error: 'Body {source, retired: boolean} required' }, 400);
    const r = await env.DB.prepare("UPDATE source_health SET retired_at = ? WHERE tenant_id = 'owner' AND source = ?").bind(b.retired ? new Date().toISOString() : null, b.source).run();
    if (!r.meta || !r.meta.changes) return json({ error: 'Unknown source' }, 404);
    return json(healthRow(await env.DB.prepare("SELECT * FROM source_health WHERE tenant_id = 'owner' AND source = ?").bind(b.source).first()));
  }
  if (path === '/api/agent/calendar/changes' && method === 'GET') { const r = await calendarChanges(env, url); return json(r.body, r.status); }
  // Run the calendar sync now (same as the 10-min cron; ?full=1 = daily window resync). Returns per-calendar counts, never tokens.
  if (path === '/api/agent/calendar/sync' && method === 'POST') {
    const r = await runCalendarSync(env, { forceFull: url.searchParams.get('full') === '1', emit: (kind, props) => emit(env, ctx, kind, { props }) });
    return json(r);
  }
  if (path === '/api/agent/mail/sync' && method === 'POST') return json(await runMailSync(env, { emit: (kind, props) => emit(env, ctx, kind, { props }) }));
  if (path === '/api/agent/mail/retag' && method === 'POST') return json(await retagMail(env));
  // B47: attachments, fetched from Gmail on demand (nothing stored)
  if (path === '/api/agent/mail/attachments' && method === 'GET') { const r = await listAttachments(env, url); return json(r.body, r.status); }
  if (path === '/api/agent/mail/attachment' && method === 'GET') {
    const r = await readAttachment(env, url, (kind, props) => emit(env, ctx, kind, { props }));
    return json(r.body, r.status);
  }
  if (path === '/api/agent/mail/messages' && method === 'GET') { const r = await mailMessages(env, url); return json(r.body, r.status); }
  const threadM = path.match(/^\/api\/agent\/mail\/threads\/([A-Za-z0-9_-]{1,100})$/);
  if (threadM && method === 'GET') { const r = await mailThread(env, threadM[1], url); return json(r.body, r.status); }
  // B42 weekly theme: GET current (or ?week_start=), PUT replaces a week's theme
  if (path === '/api/agent/theme' && method === 'GET') {
    const wk = url.searchParams.get('week_start');
    if (wk && (!isValidDate(wk) || mondayOf(wk) !== wk)) return json({ error: 'week_start must be a Monday (YYYY-MM-DD)' }, 400);
    const week = wk || mondayOf(getTodayLA());
    const r = await env.DB.prepare("SELECT * FROM weekly_theme WHERE tenant_id = 'owner' AND week_start = ?").bind(week).first();
    return json({ week_start: week, theme: themeOut(r) });
  }
  if (path === '/api/agent/theme' && method === 'PUT') {
    const b = await readBody();
    if (!b || typeof b !== 'object') return bad();
    if (!isValidDate(b.week_start) || mondayOf(b.week_start) !== b.week_start) return json({ error: 'week_start must be a Monday (YYYY-MM-DD)' }, 400);
    const vals = {};
    for (const [k, max] of Object.entries(THEME_FIELDS)) {
      const v = b[k];
      if (v === undefined || v === null || v === '') { vals[k] = null; continue; }
      if (typeof v !== 'string' || v.length > max) return json({ error: `${k} must be a string of at most ${max} chars` }, 400);
      vals[k] = v.trim() || null;
    }
    if (Object.values(vals).every(v => v === null)) return json({ error: 'At least one theme field is required' }, 400);
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO weekly_theme (tenant_id, week_start, work_title, work_line, personal_title, personal_line, through_line, updated_at) VALUES ('owner', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, week_start) DO UPDATE SET work_title = excluded.work_title, work_line = excluded.work_line, personal_title = excluded.personal_title,
         personal_line = excluded.personal_line, through_line = excluded.through_line, updated_at = excluded.updated_at`
    ).bind(b.week_start, vals.work_title, vals.work_line, vals.personal_title, vals.personal_line, vals.through_line, now).run();
    emit(env, ctx, 'theme_set', { props: { week_start: b.week_start } });
    return json({ week_start: b.week_start, theme: themeOut(await env.DB.prepare("SELECT * FROM weekly_theme WHERE tenant_id = 'owner' AND week_start = ?").bind(b.week_start).first()) });
  }

  // v1: areas, projects, headings; migration (dry run / apply)
  if (/^\/api\/agent\/(areas|projects|headings)(\/|$)/.test(path)) {
    const r = await handleStructure(request, env, ctx, url, path, method, (kind, props) => emit(env, ctx, kind, { props }));
    if (r) return r;
  }
  if (method === 'GET' && (path === '/api/agent/feedback' || /^\/api\/agent\/feedback\/[A-Za-z0-9_-]+\/screenshot$/.test(path))) return agentFeedback(env, url, path);
  if (path === '/api/agent/anomalies' && method === 'GET') return anomalies(env, url);
  if (path === '/api/agent/settings' && method === 'GET') return json(await readSettings(env));
  if (path === '/api/agent/time' && method === 'GET') return agentTime(env, url);
  if (path === '/api/agent/wake' && method === 'GET') return wake(env, url);
  if (path === '/api/agent/event-labels' || path.startsWith('/api/agent/event-labels/')) return eventLabels(env, ctx, request, url, path, { generateId, emit });
  if (path === '/api/agent/wake/ack' && method === 'POST') return wakeAck(env, request);
  if (path === '/api/agent/v1/migrate' && method === 'POST') {
    const b = (await readBody()) || {};
    const dry = url.searchParams.get('dry_run') !== '0';
    return json(await runMigration(env, b, dry, (kind, props) => emit(env, ctx, kind, { props })));
  }

  // B37 P4 views
  if (method === 'GET' && path.startsWith('/api/agent/views/')) {
    const fn = { '/api/agent/views/awaiting-me': awaitingMe, '/api/agent/views/awaiting-them': awaitingThem, '/api/agent/views/new-since': newSince }[path];
    if (fn) { const r = await fn(env, url); return json(r.body, r.status); }
  }
  // Which Worker version served this request (compare with cron_tick.version)
  if (path === '/api/agent/version' && method === 'GET') {
    const v = env.CF_VERSION_METADATA || {};
    return json({ version: v.id || null, tag: v.tag || null, timestamp: v.timestamp || null });
  }
  if (path === '/api/agent/calendar/events' && method === 'GET') { const r = await calendarEvents(env, url); return json(r.body, r.status); }
  if (path === '/api/agent/items' && method === 'GET') {
    const sinceP = url.searchParams.get('since');
    let since = new Date(Date.now() - 48 * 3600000).toISOString();
    if (sinceP) { const t = Date.parse(sinceP); if (isNaN(t)) return json({ error: 'Invalid since' }, 400); since = new Date(t).toISOString(); }
    let limit = 200;
    if (url.searchParams.has('limit')) { limit = parseInt(url.searchParams.get('limit'), 10); if (!(limit >= 1)) return json({ error: 'Invalid limit' }, 400); limit = Math.min(limit, 1000); }
    let sql = "SELECT * FROM items WHERE tenant_id = 'owner' AND ts >= ?";
    const binds = [since];
    const source = url.searchParams.get('source');
    if (source) { sql += ' AND source = ?'; binds.push(source); }
    if (url.searchParams.get('unread') === '1') sql += ' AND unread = 1';
    if (url.searchParams.get('include_removed') !== '1') sql += ' AND removed_at IS NULL';
    sql += ' ORDER BY ts DESC LIMIT ?'; binds.push(limit);
    const rows = await q(sql, ...binds);
    return json({ since, count: rows.length, items: rows.map(itemOut) });
  }
  if (path === '/api/agent/snapshot' && method === 'GET') {
    return new Response(await buildSnapshot(env, { freshness: true }), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (path === '/api/agent/brief' && method === 'POST') { const b = await readBody(); return b === undefined ? bad() : agentBrief(env, b); }
  if (path === '/api/agent/tasks' && method === 'GET') {
    const status = url.searchParams.get('status') || 'open';
    const STATUSES = ['open', 'all', 'dropped', 'backlog', 'inbox', 'suggestions', 'claude', 'trash'];
    if (!STATUSES.includes(status)) return json({ error: 'status must be one of ' + STATUSES.join(', ') }, 400);
    // v1: pending/dismissed Claude suggestions, the Claude list and trashed rows only show under their own status
    const live = "AND t.completed_at IS NULL AND t.dropped_at IS NULL AND t.trashed_at IS NULL AND COALESCE(t.suggestion_state, 'accepted') = 'accepted'";
    const mine = "AND COALESCE(t.list, 'Tasks') != 'Claude'";
    const statusSql = status === 'open' ? `${live} ${mine}`
      : status === 'dropped' ? 'AND t.dropped_at IS NOT NULL AND t.trashed_at IS NULL'
      : status === 'backlog' ? `${live} ${mine} AND t.due_date IS NULL AND t.inbox = 0`
      : status === 'inbox' ? `${live} ${mine} AND t.due_date IS NULL AND t.inbox = 1`
      : status === 'suggestions' ? "AND t.completed_at IS NULL AND t.dropped_at IS NULL AND t.trashed_at IS NULL AND t.suggestion_state = 'pending'"
      : status === 'claude' ? `${live} AND t.list = 'Claude'`
      : status === 'trash' ? 'AND t.trashed_at IS NOT NULL' : '';
    const rows = await q(
      `SELECT t.*, (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id) AS steps_total,
              (SELECT COUNT(*) FROM tasks s WHERE s.parent_task_id = t.id AND s.completed_at IS NOT NULL) AS steps_done
       FROM tasks t WHERE t.tenant_id = 'owner' AND t.parent_task_id IS NULL ${statusSql}
       ORDER BY t.due_date ASC, CASE t.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, t.title ASC LIMIT 1000`);
    return json({ today: getTodayLA(), count: rows.length, tasks: await decorate(env, rows) });
  }
  if (path === '/api/agent/tasks' && method === 'POST') { const b = await readBody(); return b === undefined ? bad() : agentTaskCreate(env, ctx, b); }
  const m = path.match(/^\/api\/agent\/tasks\/([^/]+)$/);
  if (m && method === 'PATCH') {
    const id = m[1];
    const b = await readBody();
    if (b === undefined || !b || typeof b !== 'object') return bad();
    const { completed, dropped, reason, text, series, ...rest } = b;
    if (completed !== undefined && completed !== true) return json({ error: 'completed, if present, must be true' }, 400);
    if (dropped !== undefined && typeof dropped !== 'boolean') return json({ error: 'dropped must be true (won\'t do) or false (restore)' }, 400);
    if (completed === true && dropped !== undefined) return json({ error: 'Send completed or dropped, not both' }, 400);
    if (dropped !== true && (reason !== undefined || text !== undefined || series !== undefined)) return json({ error: 'reason, text and series go with dropped: true' }, 400);
    if (dropped === true) {
      const rr = normalizeReason(reason, DROP_REASONS);
      if (rr.error) return json({ error: rr.error }, 400);
      const tt = cleanText(text, 200);
      if (tt.error) return json({ error: tt.error }, 400);
    }
    const hasRest = Object.keys(rest).length > 0;
    if (hasRest || (completed === undefined && dropped === undefined)) {
      const res = await patchTask(env, ctx, id, rest, 'agent');
      if (res.status !== 200) return res;
    }
    if (completed === true) {
      const r = await completeTask(env, ctx, id, 'agent');
      if (r.notFound) return json({ error: 'Task not found' }, 404);
    } else if (dropped !== undefined) {
      const r = dropped ? await dropTask(env, ctx, id, { reason, text, series }, 'agent') : await restoreTask(env, ctx, id, {}, 'agent');
      if (r.notFound) return json({ error: 'Task not found' }, 404);
      if (r.error) return json({ error: r.error }, r.status || 400);
    }
    return json(await env.DB.prepare('SELECT * FROM tasks WHERE id = ?').bind(id).first());
  }
  return json({ error: 'Not found' }, 404);
}

// Main handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const passphrase = env.APP_PASSPHRASE;

    // Read-only snapshot for agents: separate secret (SNAPSHOT_KEY), no session cookie, never mutates
    if (path === '/snapshot.md') {
      const key = url.searchParams.get('key') || '';
      if (request.method !== 'GET' || !env.SNAPSHOT_KEY || !safeEqual(key, env.SNAPSHOT_KEY)) {
        return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
      }
      return new Response(await buildSnapshot(env), {
        headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
      });
    }

    // Agent API: Bearer AGENT_KEY (full) or INGEST_KEY (ingest + health only), never the app cookie; checked before cookie auth
    if (path.startsWith('/api/agent/') || path === '/api/agent') {
      const scope = await agentScope(request, env);
      if (!scope) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' } });
      }
      if (scope === 'ingest' && !INGEST_SCOPE_ROUTES.has(`${request.method} ${path}`)) {
        return json({ error: 'Forbidden: ingest key may only POST /api/agent/ingest and /api/agent/health' }, 403);
      }
      try { return await handleAgent(request, env, ctx, url, path); }
      catch (e) { console.error('agent api error', String(e)); return json({ error: 'Internal error' }, 500); }
    }

    // Device tokens (Android shell): four routes only, checked before the cookie session (v1app.js deviceRequest)
    if (path.startsWith('/api/v1/')) {
      const deps = { getTodayLA, generateId, emit, completeTask, uncompleteTask };
      const dr = await deviceRequest(request, env, ctx, url, path, deps);
      if (dr) return dr;
    }

    // Public paths
    const publicPaths = ['/login', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];
    const isPublic = publicPaths.includes(path);

    // Check auth for protected routes
    const authenticated = isPublic || await validateSession(request.headers.get('cookie'), passphrase);

    // Handle login
    if (path === '/login') {
      if (request.method === 'POST') {
        const formData = await request.formData();
        const submittedPassphrase = formData.get('passphrase');

        if (passphrase && safeEqual(submittedPassphrase, passphrase)) {
          const response = new Response(null, {
            status: 302,
            headers: {
              Location: '/',
              'Set-Cookie': await createSessionCookie(passphrase),
            },
          });
          return response;
        }

        return new Response(getLoginPage(), {
          status: 401,
          headers: { 'Content-Type': 'text/html' },
        });
      }

      return new Response(getLoginPage(), {
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Redirect unauthenticated to login (or JSON 401 for API)
    if (!authenticated) {
      if (path.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(getLoginPage(), {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    // Serve static assets. The v1 UI lives in public/v1/ and is served on the v1 host(s) (BUILD-v1 (d)).
    if (!path.startsWith('/api/')) {
      if (isV1Host(url, env) && !path.startsWith('/icons/')) {
        // Pages go to '/v1/' (not '/v1/index.html': static assets 307 that to '/v1/', which would loop back here). Files are
        // served from public/v1/. Any redirect from the assets layer is resolved here so the browser never sees a /v1 URL.
        const isFile = /\.[a-z0-9]+$/i.test(path);
        const v1Path = !isFile ? '/v1/' : path.startsWith('/v1/') ? path : '/v1' + path;
        let res = await env.ASSETS.fetch(new Request(new URL(v1Path, url), request));
        for (let hops = 0; hops < 2 && res.status >= 300 && res.status < 400 && res.headers.get('location'); hops++) {
          res = await env.ASSETS.fetch(new Request(new URL(res.headers.get('location'), url), request));
        }
        return res;
      }
      return env.ASSETS.fetch(request);
    }

    // v1 app API (cookie session)
    if (path.startsWith('/api/v1/')) {
      const deps = { getTodayLA, generateId, emit, patchTask, completeTask, uncompleteTask, dropTask, restoreTask, healthStrip, currentTheme };
      return handleV1App(request, env, ctx, url, path, deps, handleStructure);
    }

    // API endpoints
    if (path === '/api/tasks' && request.method === 'GET') {
      const today = getTodayLA();
      const stmt = env.DB.prepare(
        "SELECT * FROM tasks WHERE tenant_id = ? AND parent_task_id IS NULL AND completed_at IS NULL AND dropped_at IS NULL AND trashed_at IS NULL AND COALESCE(suggestion_state, 'accepted') = 'accepted' AND COALESCE(list, 'Tasks') != 'Claude' ORDER BY due_date ASC, CASE priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 ELSE 4 END, starred DESC, title ASC"
      );
      const tasksResult = await stmt.bind('owner').all();

      // Get steps for each task
      const tasks = tasksResult.results || [];
      const tasksWithSteps = await Promise.all(
        tasks.map(async (task) => {
          const stepsStmt = env.DB.prepare(
            'SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sort_order ASC'
          );
          const stepsResult = await stepsStmt.bind(task.id).all();
          return {
            ...task,
            steps: stepsResult.results || [],
          };
        })
      );

      // Extras for B4 / B30; a failure here must never break the main list
      let completed_today = [];
      let dropped = [];
      try { [completed_today, dropped] = await Promise.all([completedToday(env), droppedRecent(env, 30)]); }
      catch (e) { console.error('tasks extras failed', String(e)); }

      return new Response(JSON.stringify({
        tasks: tasksWithSteps,
        today,
        completed_today,
        dropped,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Complete task
    if (path.match(/^\/api\/tasks\/[^/]+\/complete$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      const r = await completeTask(env, ctx, taskId);
      if (r.notFound) return json({ error: 'Task not found' }, 404);
      return json({ success: true });
    }

    // Uncomplete task
    if (path.match(/^\/api\/tasks\/[^/]+\/uncomplete$/) && request.method === 'POST') {
      const r = await uncompleteTask(env, ctx, path.split('/')[3]);
      if (r.notFound) return json({ error: 'Task not found' }, 404);
      return json({ success: true });
    }

    // Star task
    if (path.match(/^\/api\/tasks\/[^/]+\/star$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];

      const taskStmt = env.DB.prepare('SELECT starred, area FROM tasks WHERE id = ?');
      const taskResult = await taskStmt.bind(taskId).first();

      if (!taskResult) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const now = new Date().toISOString();
      const newStarred = taskResult.starred ? 0 : 1;

      const updateStmt = env.DB.prepare('UPDATE tasks SET starred = ?, updated_at = ? WHERE id = ?');
      await updateStmt.bind(newStarred, now, taskId).run();
      emit(env, ctx, newStarred ? 'task_starred' : 'task_unstarred', { task_id: taskId, area: taskResult.area });

      return new Response(JSON.stringify({ success: true, starred: newStarred }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Snooze task
    if (path.match(/^\/api\/tasks\/[^/]+\/snooze$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      const body = await request.json();
      const { to } = body;

      if (!to || !['tomorrow', 'nextweek'].includes(to)) {
        return new Response(JSON.stringify({ error: 'Invalid snooze target' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const taskStmt = env.DB.prepare('SELECT due_date, snoozed_from, area FROM tasks WHERE id = ?');
      const taskResult = await taskStmt.bind(taskId).first();

      if (!taskResult) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const now = new Date().toISOString();
      const previousDueDate = taskResult.due_date;
      const previousSnoozedFrom = taskResult.snoozed_from;

      const newDueDate = to === 'tomorrow' ? getTomorrowLA() : getNextMondayLA();
      const newSnoozedFrom = previousSnoozedFrom || previousDueDate;

      const updateStmt = env.DB.prepare(
        'UPDATE tasks SET due_date = ?, snoozed_from = ?, updated_at = ? WHERE id = ?'
      );
      await updateStmt.bind(newDueDate, newSnoozedFrom, now, taskId).run();
      emit(env, ctx, 'task_snoozed', { task_id: taskId, area: taskResult.area, props: { from: previousDueDate, to: newDueDate, target: to, rescheduled: true } });

      return new Response(JSON.stringify({
        success: true,
        previous: { due_date: previousDueDate, snoozed_from: previousSnoozedFrom },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Unsnooze task
    if (path.match(/^\/api\/tasks\/[^/]+\/unsnooze$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      const body = await request.json();
      const { due_date, snoozed_from } = body;

      if (!due_date) {
        return new Response(JSON.stringify({ error: 'Missing due_date' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const taskStmt = env.DB.prepare('SELECT id, due_date, area FROM tasks WHERE id = ?');
      const taskResult = await taskStmt.bind(taskId).first();

      if (!taskResult) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const now = new Date().toISOString();
      const updateStmt = env.DB.prepare(
        'UPDATE tasks SET due_date = ?, snoozed_from = ?, updated_at = ? WHERE id = ?'
      );
      await updateStmt.bind(due_date, snoozed_from || null, now, taskId).run();
      emit(env, ctx, 'task_unsnoozed', { task_id: taskId, area: taskResult.area, props: { from: taskResult.due_date, to: due_date } });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Update priority
    if (path.match(/^\/api\/tasks\/[^/]+\/priority$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      const body = await request.json();
      const { priority } = body;

      if (priority !== null && !['P0', 'P1', 'P2', 'P3'].includes(priority)) {
        return new Response(JSON.stringify({ error: 'Invalid priority' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const taskStmt = env.DB.prepare('SELECT id, priority, area FROM tasks WHERE id = ?');
      const taskResult = await taskStmt.bind(taskId).first();

      if (!taskResult) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const now = new Date().toISOString();
      const updateStmt = env.DB.prepare(
        'UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?'
      );
      await updateStmt.bind(priority, now, taskId).run();
      emit(env, ctx, 'task_priority', { task_id: taskId, area: taskResult.area, props: { from: taskResult.priority || null, to: priority } });

      return new Response(JSON.stringify({ success: true, priority }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create task
    if (path === '/api/tasks' && request.method === 'POST') {
      const body = await request.json();
      let { title, list, due_date, recurrence, priority, raw, explicit } = body;
      // B43: quick-add "someday"/"backlog" (or backlog: true) -> no due date; AI dates are ignored
      const backlog = body.backlog === true;
      if (backlog) { due_date = null; recurrence = null; explicit = { ...(explicit || {}), due_date: true, recurrence: true }; }
      const bodyNotes = typeof body.notes === 'string' && body.notes.trim() && body.notes.length <= 10000 ? body.notes : null;
      explicit = explicit || { due_date: false, priority: false, recurrence: false };

      let aiCleaned = false;
      let notes = bodyNotes;

      // AI cleanup is off by default (keep the text as typed, no guessed dates/priority); QUICKADD_AI=1 turns it back on
      const aiOn = env.QUICKADD_AI === '1';
      if (aiOn && raw && (raw.length > 50 || raw.split(/\s+/).length > 6)) {
        const today = getTodayLA();
        let aiResult = await cleanupWithAI(env, raw, today);

        // Parse JSON string if needed
        if (typeof aiResult === 'string') {
          try {
            aiResult = JSON.parse(aiResult);
          } catch (e) {
            aiResult = null;
          }
        }

        if (aiResult) {
          aiCleaned = true;
          notes = bodyNotes || ('Captured: ' + raw);

          // Merge: explicit > AI > parsed (validate AI values)
          if (!explicit.due_date && aiResult.due_date) {
            if (/^\d{4}-\d{2}-\d{2}$/.test(aiResult.due_date)) {
              due_date = aiResult.due_date;
            }
          }
          if (!explicit.priority && aiResult.priority) {
            if (['P0', 'P1', 'P2', 'P3'].includes(aiResult.priority)) {
              priority = aiResult.priority;
            }
          }
          if (!explicit.recurrence && aiResult.recurrence) {
            if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(aiResult.recurrence)) {
              recurrence = aiResult.recurrence;
            }
          }

          // Use AI title unless parsed title is good
          if (aiResult.title && typeof aiResult.title === 'string' && aiResult.title.length > 0 && aiResult.title.length <= 200) {
            title = aiResult.title;
          }
        }
      }

      // Set notes even if AI failed (raw was long)
      if (aiOn && !aiCleaned && raw && (raw.length > 50 || raw.split(/\s+/).length > 6)) {
        notes = bodyNotes || ('Captured: ' + raw);
      }

      const validation = validateTaskFields(title, list, due_date, recurrence, priority);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      const area = body.area || null;
      if (area !== null && !AREAS.includes(area)) {
        return json({ error: 'Invalid area' }, 400);
      }

      const taskId = 't-' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
      const now = new Date().toISOString();
      // Inbox: an undated, non-repeating quick-add waits in the Inbox until it gets a date or goes to the backlog
      const inbox = !backlog && !due_date && !recurrence && body.inbox !== false;
      const finalDueDate = backlog || inbox ? null : (due_date || getTodayLA());

      const insertStmt = env.DB.prepare(
        'INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, notes, area, inbox, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      await insertStmt.bind(taskId, 'owner', list || 'Tasks', title.trim(), priority || DEFAULT_PRIORITY, finalDueDate, recurrence || null, notes, area, inbox ? 1 : 0, now, now).run();
      emit(env, ctx, 'task_created', { task_id: taskId, area, props: { list: list || 'Tasks', priority: priority || DEFAULT_PRIORITY, due_date: finalDueDate, recurrence: recurrence || null, ai_cleaned: aiCleaned } });
      if (backlog) emit(env, ctx, 'task_backlogged', { task_id: taskId, area, props: { via: 'quick_add', created: true } });
      if (inbox) emit(env, ctx, 'quickadd_inbox', { task_id: taskId, area, props: {} });

      const getStmt = env.DB.prepare('SELECT * FROM tasks WHERE id = ?');
      const newTask = await getStmt.bind(taskId).first();

      return new Response(JSON.stringify({ ...newTask, ai_cleaned: aiCleaned }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get brief and suggestions
    if (path === '/api/brief' && request.method === 'GET') {
      const today = getTodayLA();

      // Get latest brief with date <= LA today
      const briefStmt = env.DB.prepare(
        'SELECT * FROM briefs WHERE tenant_id = ? AND date <= ? ORDER BY date DESC LIMIT 1'
      );
      const brief = await briefStmt.bind('owner', today).first();

      // Get all pending suggestions
      const suggestionsStmt = env.DB.prepare(
        'SELECT * FROM suggestions WHERE tenant_id = ? AND status = ? ORDER BY created_at ASC'
      );
      const suggestionsResult = await suggestionsStmt.bind('owner', 'pending').all();
      emit(env, ctx, 'brief_viewed', { props: { brief_date: brief ? brief.date : null, suggestions: (suggestionsResult.results || []).length } });

      let sources = [];
      try { sources = await healthStrip(env); } catch (e) { console.error('health strip failed', String(e)); }
      let theme = null;
      try { theme = await currentTheme(env); } catch (e) { console.error('theme failed', String(e)); }
      return new Response(JSON.stringify({
        brief: brief || null,
        suggestions: suggestionsResult.results || [],
        today,
        sources,
        theme,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Accept suggestion
    if (path.match(/^\/api\/suggestions\/[^/]+\/accept$/) && request.method === 'POST') {
      const suggestionId = path.split('/')[3];
      const body = await request.json() || {};

      const suggStmt = env.DB.prepare('SELECT * FROM suggestions WHERE id = ? AND tenant_id = ?');
      const suggestion = await suggStmt.bind(suggestionId, 'owner').first();

      if (!suggestion) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (suggestion.status !== 'pending') {
        return new Response(JSON.stringify({ error: 'Suggestion not pending' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Validate fields
      const finalDueDate = body.due_date || suggestion.due_date || getTodayLA();
      const finalPriority = body.priority || suggestion.priority || DEFAULT_PRIORITY;
      const validation = validateTaskFields(suggestion.title, suggestion.list, finalDueDate, suggestion.recurrence, finalPriority);
      if (!validation.valid) {
        return new Response(JSON.stringify({ error: validation.error }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Create task
      const taskId = 't-' + [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, '0')).join('');
      const now = new Date().toISOString();

      const insertTaskStmt = env.DB.prepare(
        'INSERT INTO tasks (id, tenant_id, list, title, priority, due_date, recurrence, area, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      await insertTaskStmt.bind(taskId, 'owner', suggestion.list, suggestion.title, finalPriority || null, finalDueDate, suggestion.recurrence || null, suggestion.area || null, now, now).run();

      // Update suggestion status
      const updateStmt = env.DB.prepare(
        'UPDATE suggestions SET status = ?, task_id = ?, decided_at = ? WHERE id = ?'
      );
      await updateStmt.bind('accepted', taskId, now, suggestionId).run();
      emit(env, ctx, 'suggestion_accepted', { suggestion_id: suggestionId, task_id: taskId, area: suggestion.area, props: { source: suggestion.source || null, brief_date: suggestion.brief_date } });
      emit(env, ctx, 'task_created', { task_id: taskId, area: suggestion.area, props: { list: suggestion.list, priority: finalPriority || null, due_date: finalDueDate, recurrence: suggestion.recurrence || null, via: 'suggestion' } });

      const getTaskStmt = env.DB.prepare('SELECT * FROM tasks WHERE id = ?');
      const newTask = await getTaskStmt.bind(taskId).first();

      return new Response(JSON.stringify(newTask), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Dismiss suggestion
    if (path.match(/^\/api\/suggestions\/[^/]+\/dismiss$/) && request.method === 'POST') {
      const suggestionId = path.split('/')[3];

      const suggStmt = env.DB.prepare('SELECT * FROM suggestions WHERE id = ? AND tenant_id = ?');
      const suggestion = await suggStmt.bind(suggestionId, 'owner').first();

      if (!suggestion) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (suggestion.status !== 'pending') {
        return new Response(JSON.stringify({ error: 'Suggestion not pending' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const now = new Date().toISOString();
      const updateStmt = env.DB.prepare(
        'UPDATE suggestions SET status = ?, decided_at = ? WHERE id = ?'
      );
      await updateStmt.bind('dismissed', now, suggestionId).run();
      emit(env, ctx, 'suggestion_dismissed', { suggestion_id: suggestionId, area: suggestion.area, props: { source: suggestion.source || null, brief_date: suggestion.brief_date } });

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Won't do (B30): body { reason?, text?, series?: 'skip'|'stop' (recurring only) }
    if (path.match(/^\/api\/tasks\/[^/]+\/drop$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }
      const r = await dropTask(env, ctx, taskId, body || {});
      if (r.notFound) return json({ error: 'Task not found' }, 404);
      if (r.error) return json({ error: r.error }, r.status || 400);
      return json({ success: true, task: r.task, skipped: !!r.skipped, previous: r.previous || null });
    }

    // Restore a Won't do (or undo a skip with { due_date, snoozed_from })
    if (path.match(/^\/api\/tasks\/[^/]+\/restore$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      let body;
      try { body = await request.json(); } catch (e) { body = {}; }
      const r = await restoreTask(env, ctx, taskId, body || {});
      if (r.notFound) return json({ error: 'Task not found' }, 404);
      if (r.error) return json({ error: r.error }, r.status || 400);
      return json({ success: true, task: r.task });
    }

    // Prompt answers (B28 why-later, B29 outcome): append a dated notes line + reason on the event
    if (path.match(/^\/api\/tasks\/[^/]+\/signal$/) && request.method === 'POST') {
      const taskId = path.split('/')[3];
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
      return recordSignal(env, ctx, taskId, body);
    }

    // Edit task (partial update)
    if (path.match(/^\/api\/tasks\/[^/]+$/) && request.method === 'PATCH') {
      const taskId = path.split('/')[3];
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
      return patchTask(env, ctx, taskId, body);
    }

    // Delete task (and its steps)
    if (path.match(/^\/api\/tasks\/[^/]+$/) && request.method === 'DELETE') {
      const taskId = path.split('/')[3];

      const taskStmt = env.DB.prepare('SELECT * FROM tasks WHERE id = ?');
      const taskResult = await taskStmt.bind(taskId).first();

      if (!taskResult) {
        return new Response(JSON.stringify({ error: 'Task not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Delete all steps (child tasks)
      const deleteStepsStmt = env.DB.prepare('DELETE FROM tasks WHERE parent_task_id = ?');
      await deleteStepsStmt.bind(taskId).run();

      // Delete the task itself
      const deleteStmt = env.DB.prepare('DELETE FROM tasks WHERE id = ?');
      await deleteStmt.bind(taskId).run();

      if (!taskResult.parent_task_id) {
        emit(env, ctx, 'task_deleted', {
          task_id: taskId, area: taskResult.area,
          props: {
            title: taskResult.title, list: taskResult.list, due_date: taskResult.due_date,
            was_overdue: !!taskResult.due_date && taskResult.due_date < getTodayLA(),
          },
        });
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Client telemetry (whitelisted kinds only; no titles)
    if (path === '/api/events' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON' }, 400); }
      const kind = body && body.kind;
      if (!CLIENT_EVENT_KINDS.includes(kind)) return json({ error: 'Unknown kind' }, 400);
      const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
      const p = (body.props && typeof body.props === 'object') ? body.props : {};
      let props = {};
      if (kind === 'app_open') props = { mode: p.mode === 'standalone' ? 'standalone' : 'browser' };
      else if (kind === 'view') props = { name: clip(p.name, 40) };
      else if (kind === 'sheet_opened') props = {};
      const taskId = kind === 'sheet_opened' && typeof body.task_id === 'string' && /^[\w-]{1,40}$/.test(body.task_id) ? body.task_id : null;
      emit(env, ctx, kind, { task_id: taskId, props });
      return json({ ok: true }, 202);
    }

    // Stats for the weekly loop review
    if (path === '/api/stats' && request.method === 'GET') {
      let days = parseInt(url.searchParams.get('days') || '7', 10);
      if (!(days >= 1)) days = 7;
      days = Math.min(days, 365);
      const now = Date.now();
      const since = new Date(now - days * 86400000).toISOString();
      const cutoff7 = new Date(now - 7 * 86400000).toISOString();
      const today = getTodayLA();
      // LA offset in hours (7 in PDT, 8 in PST) for bucketing by local day
      const laHour = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now)), 10);
      const offset = (new Date(now).getUTCHours() - laHour + 24) % 24;
      const T = 'owner';
      const q = (sql, ...binds) => env.DB.prepare(sql).bind(...binds).all().then(r => r.results || []);

      const [kinds, comp, compByArea, repeat, untouched, sugg, opens] = await Promise.all([
        q('SELECT kind, COUNT(*) AS n FROM events WHERE tenant_id = ? AND at >= ? GROUP BY kind ORDER BY n DESC', T, since),
        q(`SELECT COALESCE(SUM(CASE WHEN json_extract(props, '$.late') = 1 THEN 0 ELSE 1 END), 0) AS on_time,
                  COALESCE(SUM(CASE WHEN json_extract(props, '$.late') = 1 THEN 1 ELSE 0 END), 0) AS late
           FROM events WHERE tenant_id = ? AND at >= ? AND kind = 'task_completed'`, T, since),
        q(`SELECT COALESCE(area, 'none') AS area,
                  SUM(CASE WHEN json_extract(props, '$.late') = 1 THEN 0 ELSE 1 END) AS on_time,
                  SUM(CASE WHEN json_extract(props, '$.late') = 1 THEN 1 ELSE 0 END) AS late
           FROM events WHERE tenant_id = ? AND at >= ? AND kind = 'task_completed' GROUP BY COALESCE(area, 'none') ORDER BY area`, T, since),
        q(`SELECT e.task_id AS id, COALESCE(t.title, (SELECT json_extract(d.props, '$.title') FROM events d WHERE d.task_id = e.task_id AND d.kind = 'task_deleted' LIMIT 1)) AS title,
                  COUNT(*) AS count, t.due_date AS due_date, t.area AS area
           FROM events e LEFT JOIN tasks t ON t.id = e.task_id
           WHERE e.tenant_id = ? AND e.at >= ? AND e.task_id IS NOT NULL
             AND (e.kind = 'task_snoozed' OR (e.kind = 'task_edited' AND json_extract(e.props, '$.rescheduled') = 1))
           GROUP BY e.task_id HAVING COUNT(*) >= 2 ORDER BY count DESC, title`, T, since),
        q(`SELECT t.id, t.title, t.due_date, t.priority, t.area FROM tasks t
           WHERE t.tenant_id = ? AND t.parent_task_id IS NULL AND t.completed_at IS NULL AND t.dropped_at IS NULL AND t.due_date < ?
             AND replace(substr(t.updated_at, 1, 19), 'T', ' ') < ?
             AND NOT EXISTS (SELECT 1 FROM events e WHERE e.task_id = t.id AND e.at >= ?)
           ORDER BY t.due_date ASC`, T, today, cutoff7.slice(0, 19).replace('T', ' '), cutoff7),
        q(`SELECT COALESCE(json_extract(props, '$.source'), 'unknown') AS source,
                  SUM(CASE WHEN kind = 'suggestion_accepted' THEN 1 ELSE 0 END) AS accepted,
                  SUM(CASE WHEN kind = 'suggestion_dismissed' THEN 1 ELSE 0 END) AS dismissed
           FROM events WHERE tenant_id = ? AND at >= ? AND kind IN ('suggestion_accepted', 'suggestion_dismissed')
           GROUP BY source ORDER BY source`, T, since),
        q(`SELECT date(at, ?) AS day, COUNT(*) AS n FROM events
           WHERE tenant_id = ? AND at >= ? AND kind = 'app_open' GROUP BY day ORDER BY day`, `-${offset} hours`, T, since),
      ]);

      const daysLate = await q(`SELECT COALESCE(AVG(json_extract(props, '$.days_late')), 0) AS avg_days_late FROM events WHERE tenant_id = ? AND at >= ? AND kind = 'task_completed' AND json_extract(props, '$.late') = 1`, T, since);

      const counts = {};
      for (const r of kinds) counts[r.kind] = r.n;
      return json({
        days, since, today,
        counts_by_kind: counts,
        completions: {
          on_time: comp[0].on_time, late: comp[0].late,
          avg_days_late: Math.round(daysLate[0].avg_days_late * 10) / 10,
          by_area: compByArea,
        },
        repeatedly_pushed: repeat,
        overdue_untouched_7d: untouched,
        suggestions_by_source: sugg,
        app_open_by_day: opens,
      });
    }

    // 404
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Crons: every 10 min calendar sync, offset 10-min mail sync (B37); daily purge of collected items not seen for 30 days + calendar full resync and retention
  async scheduled(event, env, ctx) {
    const cron = String(event.cron || '').trim().replace(/\s+/g, ' ');
    // Diagnostic tick (B37): record every invocation, awaited, before any work, so ticks are visible in D1
    const version = env.CF_VERSION_METADATA ? env.CF_VERSION_METADATA.id || null : null;
    try {
      await env.DB.prepare('INSERT INTO events (id, tenant_id, at, kind, props) VALUES (?, ?, ?, ?, ?)').bind(
        'e-' + generateId(), 'owner', new Date().toISOString(), 'cron_tick',
        JSON.stringify({ cron, scheduled_time: event.scheduledTime ? new Date(event.scheduledTime).toISOString() : null, version })
      ).run();
    } catch (err) { console.error('cron_tick event write failed', String(err)); }
    // Second, independent trace in a known-good table, plus a log line (visible in Workers Logs)
    console.log('cron tick', cron, version);
    try {
      await env.DB.prepare(
        `INSERT INTO source_health (tenant_id, source, last_ok, last_attempt, last_error, stale_after_hours) VALUES ('owner', 'cron_tick', ?1, ?1, ?2, 1)
         ON CONFLICT(tenant_id, source) DO UPDATE SET last_ok = excluded.last_ok, last_attempt = excluded.last_attempt, last_error = excluded.last_error`
      ).bind(new Date().toISOString(), `last cron: ${cron}`).run();
    } catch (err) { console.error('cron_tick health write failed', String(err)); }
    const log = (kind, props) => emit(env, ctx, kind, { props });
    if (cron === '*/10 * * * *') {
      ctx.waitUntil(runCalendarSync(env, { emit: log }).catch(err => console.error('calendar sync failed', String(err))));
      return;
    }
    // Mail runs on its own schedule (offset 5 min) so it has its own subrequest/CPU budget and never starves calendar
    if (cron === '5-55/10 * * * *') {
      ctx.waitUntil(runMailSync(env, { emit: log }).catch(err => console.error('mail sync failed', String(err))));
      return;
    }
    if (cron !== '17 11 * * *') { console.error('unknown cron', cron); return; }
    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    ctx.waitUntil(env.DB.prepare('DELETE FROM items WHERE last_seen < ?').bind(cutoff).run());
    ctx.waitUntil(runCalendarSync(env, { forceFull: true, emit: log }).then(() => purgeCalendar(env)).catch(err => console.error('calendar daily failed', String(err))));
    ctx.waitUntil(purgeMail(env).catch(err => console.error('mail purge failed', String(err))));
    ctx.waitUntil(purgeItemMedia(env).catch(err => console.error('media purge failed', String(err))));
  },
};
