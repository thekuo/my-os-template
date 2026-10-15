// Runs public/app.js in a vm with a permissive DOM stub to catch runtime errors in render() and the
// prompt sheets (no browser here). Not a visual test. Run: node scripts/test-app-render.mjs
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import assert from 'assert/strict';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf-8');

const elements = new Map(); // id -> element
function makeEl(tag = 'div') {
  const listeners = {};
  const el = {
    tagName: tag.toUpperCase(), id: '', className: '', dataset: {}, style: {}, value: '', disabled: false, _html: '',
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener(k, fn) { (listeners[k] ||= []).push(fn); },
    removeEventListener() {},
    _fire(k, ev = {}) { for (const fn of listeners[k] || []) fn({ preventDefault() {}, stopPropagation() {}, target: el, currentTarget: el, button: 0, clientX: 0, clientY: 0, closest: () => null, ...ev }); },
    appendChild(c) { if (c.id) elements.set(c.id, c); return c; },
    remove() { if (el.id) elements.delete(el.id); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; },
    closest() { return makeEl(); },
    focus() {},
    set innerHTML(v) { el._html = String(v); },
    get innerHTML() { return el._html; },
    set textContent(v) { el._html = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
    get textContent() { return el._html; },
  };
  return el;
}
const appEl = makeEl(); appEl.id = 'app'; elements.set('app', appEl);
const document = {
  body: makeEl('body'),
  getElementById: (id) => {
    if (elements.has(id)) return elements.get(id);
    // Elements created via innerHTML: resolve when some live element's HTML declares the id
    for (const el of elements.values()) if (el._html.includes(`id="${id}"`)) { const c = makeEl(); c._owner = el; return c; }
    return null;
  },
  createElement: (t) => makeEl(t),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {}, removeEventListener() {},
  visibilityState: 'visible',
};
document.body.appendChild = (c) => { if (c.id) elements.set(c.id, c); return c; };

const today = '2026-10-07';
const fixture = {
  today,
  tasks: [
    { id: 't-1', title: 'Call the clinic', list: 'Tasks', due_date: today, priority: 'P1', area: 'health', notes: null, recurrence: null, ask_outcome: 1, steps: [] },
    { id: 't-2', title: 'Daily thing', list: 'Tasks', due_date: today, recurrence: 'daily', ask_outcome: 0, steps: [] },
  ],
  completed_today: [
    { task_id: 't-3', title: 'Done <b>one</b>', completed_at: '2026-10-07T16:00:00Z', recurring: false, can_undo: true, area: 'house' },
    { task_id: 't-2', title: 'Daily thing', completed_at: '2026-10-07T15:00:00Z', recurring: true, can_undo: false },
  ],
  dropped: [
    { id: 't-4', title: 'Dropped <i>x</i>', area: 'work', dropped_at: '2026-10-06T10:00:00Z', notes: "old\n2026-10-06 won't do: Not worth it (meh)", recurrence: null },
  ],
};
const calls = [];
async function fetchStub(url, opts = {}) {
  calls.push([opts.method || 'GET', url, opts.body ? JSON.parse(opts.body) : null]);
  let body = { ok: true };
  if (url === '/api/tasks') body = fixture;
  if (url === '/api/brief') body = { brief: null, suggestions: [], today, sources: [
    { source: 'gcal_sync', label: 'Calendar', status: 'ok', age_hours: 0.1, error: null },
    { source: 'gmail_sync', label: 'Mail', status: 'warn', age_hours: 0.3, error: 'rate limited, will retry ("x")' },
    { source: 'beeper', label: 'Chats', status: 'off' },
  ], theme: { week_start: '2026-10-05', work_title: 'Ship <b>v2</b>', work_line: 'Close the loop', personal_title: 'Rest', personal_line: null, through_line: 'Less, but better' } };
  if (/\/drop$/.test(url)) body = { success: true, task: { ...fixture.tasks[1], due_date: '2026-10-08' }, skipped: true, previous: { due_date: today, snoozed_from: null } };
  if (/\/snooze$/.test(url)) body = { success: true, previous: { due_date: today, snoozed_from: null } };
  return { ok: true, status: 200, json: async () => body };
}

const ctx = {
  document, window: { location: {}, matchMedia: () => ({ matches: false }), navigator: {} }, navigator: {},
  localStorage: { getItem: () => null, setItem() {} }, fetch: fetchStub, console,
  setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout, Date, Intl, JSON, Math, Array, Object, String, Promise, Map, Set,
};
vm.createContext(ctx);
vm.runInContext(src, ctx);
const tick = () => new Promise(r => setTimeout(r, 30));
await tick();

let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const run = (code) => vm.runInContext(code, ctx);

// Planned view renders, with Completed today (B4 is added in a later commit; tolerate absence)
ok(appEl.innerHTML.includes('Call the clinic'), 'task rendered');
ok(appEl.innerHTML.includes('data-filter="dropped"'), "Won't do chip");

// Won't do list
run("selectedFilter = 'dropped'; render();");
ok(appEl.innerHTML.includes('Dropped &lt;i&gt;x&lt;/i&gt;'), 'dropped title escaped');
ok(appEl.innerHTML.includes('Not worth it (meh)'), 'reason shown');
ok(appEl.innerHTML.includes('restore-btn'), 'restore button');
run("selectedFilter = 'all'; render();");

// Outcome sheet
run("openOutcomeSheet(tasks[0]);");
const ps = elements.get('prompt-sheet-root');
ok(ps && ps.innerHTML.includes('Outcome?') && ps.innerHTML.includes('What did they say?'), 'outcome sheet');
run('closePromptSheet();');
ok(!elements.get('prompt-sheet-root'), 'closed');

// Won't do sheet for a recurring task -> segment + chips; choose runs drop with series
run('openWontDoSheet(tasks[1]);');
const ws = elements.get('prompt-sheet-root');
ok(ws.innerHTML.includes('Skip this one') && ws.innerHTML.includes('Overtaken by events'), 'wont do sheet');
await run("promptState.cfg.onChoose('duplicate', 'x', 'skip')");
const drop = calls.find(c => /\/drop$/.test(c[1]));
ok(drop && drop[2].reason === 'duplicate' && drop[2].series === 'skip' && drop[2].text === 'x', JSON.stringify(drop));

// Helpers
ok(run("wontDoReason(\"a\\n2026-10-07 won't do (skipped Oct 7): Duplicate\")") === 'Duplicate');
ok(run("wontDoReason('plain note')") === '');
ok(run("outcomePlaceholder('Dentist appointment')") === 'How did it go?');
ok(run("outcomePlaceholder('Decide on camp')") === 'What did you decide?');

// Optional (commit 3): why-later + completed today
if (run("typeof shouldAskWhy") === 'function') {
  ok(run("shouldAskWhy({ recurrence: null }, '2026-10-07', '2026-10-08')") === true);
  ok(run("shouldAskWhy({ recurrence: 'daily' }, '2026-10-07', '2026-10-08')") === true);
  ok(run("shouldAskWhy({ recurrence: null }, '2026-10-09', '2026-10-08')") === false);
  ok(run("shouldAskWhy({ recurrence: null }, null, '2026-10-08')") === false);
  run("openWhyLaterSheet(tasks[0], '2026-10-08', null);");
  ok(elements.get('prompt-sheet-root').innerHTML.includes('Why later?'), 'why sheet');
  await run("promptState.cfg.onChoose('waiting', '', null)");
  const sig = calls.find(c => /\/signal$/.test(c[1]) && c[2].kind === 'later');
  ok(sig && sig[2].reason === 'waiting', JSON.stringify(sig));
  run("doneOpen = true; selectedFilter = 'all'; render();");
  ok(appEl.innerHTML.includes('Completed today (2)'), 'completed header');
  ok(appEl.innerHTML.includes('Done &lt;b&gt;one&lt;/b&gt;'), 'completed escaped');
  ok((appEl.innerHTML.match(/done-undo/g) || []).length === 1, 'one undo (can_undo)');
}

// B34: quick-add sends the scope's area (work -> 'work', else null)
run("scope = 'work';");
await run("createTask('Ship deck', null, null, null, 'Tasks', 'ship deck', {})");
let add = calls.filter(c => c[0] === 'POST' && c[1] === '/api/tasks').pop();
ok(add && add[2].area === 'work', JSON.stringify(add));
run("scope = 'personal';");
await run("createTask('Buy milk', null, null, null, 'Tasks', 'buy milk', {})");
add = calls.filter(c => c[0] === 'POST' && c[1] === '/api/tasks').pop();
ok(add && add[2].area === null, JSON.stringify(add));
run("scope = 'all';");
await run("createTask('Buy eggs', null, null, null, 'Tasks', 'buy eggs', {})");
add = calls.filter(c => c[0] === 'POST' && c[1] === '/api/tasks').pop();
ok(add && add[2].area === null, JSON.stringify(add));

// B37 P4: health strip
ok(appEl.innerHTML.includes('health-strip') && appEl.innerHTML.includes('health-chip health-ok') && appEl.innerHTML.includes('health-chip health-warn'), 'health strip');
ok(appEl.innerHTML.includes('&quot;x&quot;') && !appEl.innerHTML.includes('("x")"'), 'detail attribute escaped');
ok(appEl.innerHTML.includes('6m ago'), 'age label');
run("sources = [{ source: 'gcal_sync', label: 'Calendar', status: 'off' }]; render();");
ok(!appEl.innerHTML.includes('health-strip'), 'hidden when nothing is set up');
run("sources = []; render();");
ok(!appEl.innerHTML.includes('health-strip'), 'hidden without sources');

// B42: weekly theme card
{
  run("sources = [{ source: 'gcal_sync', label: 'Calendar', status: 'ok', age_hours: 0.1 }]; render();");
  const h = appEl.innerHTML;
  ok(h.includes('theme-card') && h.includes('This week'), 'theme card');
  ok(h.includes('Ship &lt;b&gt;v2&lt;/b&gt;') && !h.includes('<b>v2</b>'), 'theme escaped');
  ok(h.includes('Close the loop') && h.includes('<em>Less, but better</em>'), 'lines + through-line');
  ok(h.indexOf('theme-card') < h.indexOf('health-strip'), 'above the health strip');
  run("themeCollapsed = true; render();");
  ok(appEl.innerHTML.includes('theme-card collapsed') && !appEl.innerHTML.includes('Close the loop'), 'collapsed hides lines');
  run("themeCollapsed = false; theme = { week_start: '2026-10-05', work_title: null, work_line: null, personal_title: 'Rest', personal_line: null, through_line: null }; render();");
  ok(!appEl.innerHTML.includes('theme-label">Work') && appEl.innerHTML.includes('theme-label">Personal'), 'empty rows omitted');
  run("theme = null; render();");
  ok(!appEl.innerHTML.includes('theme-card'), 'hidden without a theme');
}

// B43: Backlog section (undated tasks), grouped by area, scope-filtered, collapsed by default
{
  run(`tasks.push({ id: 't-b1', title: 'Learn <i>piano</i>', list: 'Tasks', due_date: null, priority: 'P3', area: 'family', steps: [] },
                   { id: 't-b2', title: 'Fix fence', list: 'Tasks', due_date: null, priority: 'P2', area: null, steps: [] },
                   { id: 't-b3', title: 'Update deck', list: 'Tasks', due_date: null, priority: 'P2', area: 'work', steps: [] });
       selectedFilter = 'all'; scope = 'all'; backlogOpen = false; render();`);
  let h = appEl.innerHTML;
  ok(h.includes('Backlog (3)') && !h.includes('backlog-row'), 'collapsed by default with count');
  ok(!h.includes('No date'), 'no No-date group in the planned list');
  run('backlogOpen = true; render();');
  h = appEl.innerHTML;
  ok(h.includes('Learn &lt;i&gt;piano&lt;/i&gt;'), 'escaped');
  ok(h.indexOf('>family<') < h.indexOf('>work<') && h.indexOf('>work<') < h.indexOf('>No area<'), 'grouped by area, No area last');
  ok((h.match(/class="backlog-date"/g) || []).length === 3 && h.includes('data-schedule-id="t-b2"'), 'schedule picker per row');
  run("scope = 'personal'; render();");
  ok(appEl.innerHTML.includes('Backlog (2)') && !appEl.innerHTML.includes('Update deck'), 'personal scope');
  run("scope = 'work'; render();");
  ok(appEl.innerHTML.includes('Backlog (1)') && appEl.innerHTML.includes('Update deck'), 'work scope');
  run("scope = 'all'; render();");
  // Edit sheet for a backlog task keeps it undated; quick-add sends backlog
  run("openEditSheet(tasks.find(t => t.id === 't-b1'));");
  ok(elements.get('edit-sheet-root') ? elements.get('edit-sheet-root').innerHTML.includes('In the backlog') : true, 'sheet hint');
  run('closeEditSheet();');
  // Schedule -> PATCH due_date
  await run("scheduleTask('t-b2', '2026-10-20')");
  const sch = calls.filter(c => c[0] === 'PATCH' && c[1] === '/api/tasks/t-b2').pop();
  ok(sch && sch[2].due_date === '2026-10-20', JSON.stringify(sch));
  await run("createTask('Learn piano', null, null, null, 'Tasks', 'learn piano someday', {}, true)");
  const add = calls.filter(c => c[0] === 'POST' && c[1] === '/api/tasks').pop();
  ok(add[2].backlog === true && add[2].due_date === null, JSON.stringify(add));
}

// Quick-add Inbox: untriaged undated quick-adds on top, with a badge; not in the backlog
{
  run(`tasks.push({ id: 't-in1', title: 'Call <u>plumber</u>', list: 'Tasks', due_date: null, inbox: 1, priority: 'P2', area: null, steps: [] },
                   { id: 't-in2', title: 'Work idea', list: 'Tasks', due_date: null, inbox: 1, priority: 'P2', area: 'work', steps: [] });
       scope = 'all'; areaFilter = null; selectedFilter = 'all'; backlogOpen = true; render();`);
  let h = appEl.innerHTML;
  ok(h.includes('inbox-badge">2<'), 'badge count');
  ok(h.includes('Call &lt;u&gt;plumber&lt;/u&gt;'), 'escaped row');
  const inboxAt = h.indexOf('inbox-group'), datedAt = h.indexOf('<div class="task-group">');
  ok(inboxAt > -1 && datedAt > -1 && inboxAt < datedAt, 'Inbox above the dated groups');
  ok(!h.includes('data-backlog-open="t-in1"'), 'Inbox tasks are not in the backlog');
  run("scope = 'personal'; render();");
  ok(appEl.innerHTML.includes('inbox-badge">1<'), 'scope-filtered');
  run("scope = 'all'; render();");
  // Edit sheet: Inbox hint + Move to backlog
  run("openEditSheet(tasks.find(t => t.id === 't-in1'));");
  const sh = elements.get('edit-sheet-root');
  if (sh) ok(sh.innerHTML.includes('In the Inbox') && sh.innerHTML.includes('sheet-to-backlog'), 'sheet inbox hint');
  run('closeEditSheet();');
  // Quick-add sends no date unless one was typed; a typed date is sent
  await run("createTask('Call plumber', null, null, null, 'Tasks', 'call plumber', { due_date: false }, false)");
  let add = calls.filter(c => c[0] === 'POST' && c[1] === '/api/tasks').pop();
  ok(add[2].due_date === null && !add[2].backlog, JSON.stringify(add[2]));
  run("render();"); // fixture reloaded by the quick-add refresh: no Inbox tasks
  ok(!appEl.innerHTML.includes('inbox-group'), 'hidden when empty');
}

console.log(`test-app-render: ${checks} checks passed`);
process.exit(0);
