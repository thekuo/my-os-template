let tasks = [];
let today = '';
let brief = null;
let sources = []; // B37 P4: collector health for the strip
let theme = null; // B43: Backlog = open tasks without a due date, grouped by area, scope-filtered; each row has a Schedule date picker
function backlogTasks() {
  return tasks.filter(t => !t.due_date && !t.inbox && inScope(t.area) && (!areaFilter || t.area === areaFilter));
}
function renderBacklog() {
  const list = backlogTasks();
  if (!list.length) return '';
  let html = `<div class="done-section backlog-section"><button type="button" class="done-header" id="backlog-toggle"><span>Backlog (${list.length})</span><span>${backlogOpen ? '▼' : '▶'}</span></button>`;
  if (backlogOpen) {
    const groups = new Map();
    for (const t of list) { const k = t.area || ''; (groups.get(k) || groups.set(k, []).get(k)).push(t); }
    const keys = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b)));
    for (const k of keys) {
      html += `<div class="backlog-group"><div class="backlog-area">${k ? escapeHtml(k) : 'No area'}</div>`;
      for (const t of groups.get(k)) {
        html += `<div class="backlog-row" data-backlog-id="${escAttr(t.id)}">
          <button type="button" class="backlog-title" data-backlog-open="${escAttr(t.id)}">${t.priority ? `<span class="backlog-prio">${escapeHtml(t.priority)}</span> ` : ''}${escapeHtml(t.title)}</button>
          <label class="backlog-schedule">Schedule<input type="date" class="backlog-date" data-schedule-id="${escAttr(t.id)}" min="${escAttr(today)}" aria-label="Schedule ${escAttr(t.title)}"></label>
        </div>`;
      }
      html += '</div>';
    }
  }
  return html + '</div>';
}

// Inbox: untriaged undated quick-adds, shown at the top of the list until they get a date or go to the backlog
function inboxTasks() {
  return tasks.filter(t => t.inbox && !t.due_date && inScope(t.area) && (!areaFilter || t.area === areaFilter));
}
function renderInbox() {
  const list = inboxTasks();
  if (!list.length) return '';
  let html = `<div class="task-group inbox-group"><div class="group-header inbox-header">Inbox <span class="inbox-badge">${list.length}</span></div>`;
  for (const t of list) html += renderTaskRow(t);
  return html + '</div>';
}

async function scheduleTask(taskId, date) {
  try {
    const res = await fetch(`/api/tasks/${taskId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ due_date: date }) });
    if (res.ok) await fetchTasks();
  } catch (e) { console.error('Failed to schedule:', e); }
}

// B42: this week's theme
let themeCollapsed = false;
let backlogOpen = false; // B43: Backlog section (collapsed by default)
try { themeCollapsed = localStorage.getItem('myos_theme_collapsed') === '1'; } catch (e) { /* ignore */ }
let suggestions = [];
let selectedFilter = 'all';
let undoToastTimeout = null;
let snoozeUndoMap = {}; // Maps taskId to { due_date, snoozed_from } for undo
let briefCollapsed = {}; // Track collapsed state by brief date
let areaFilter = null; // null = all areas
let completedToday = []; // B4: [{task_id, title, completed_at, recurring, can_undo}]
let droppedTasks = []; // B30: Won't do tasks, last 30 days
let doneOpen = false; // B4: Completed today section expanded
let scope = 'all'; // B32: all | personal | work
try { scope = localStorage.getItem('myos_scope') || 'all'; } catch (e) { /* ignore */ }
try { doneOpen = localStorage.getItem('myos_done_open') === '1'; } catch (e) { /* ignore */ }

// B32: personal = every area except work (and untagged)
function inScope(area) {
  if (scope === 'work') return area === 'work';
  if (scope === 'personal') return area !== 'work';
  return true;
}

const AREAS = ['kids', 'family', 'health', 'work', 'venture', 'finance', 'house'];

// Fire-and-forget telemetry (same-origin fetch carries the session cookie). Never blocks or throws.
function track(kind, props, taskId) {
  try {
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, props: props || {}, task_id: taskId || undefined }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* ignore */ }
}

// app_open at most once per 30 minutes
function trackAppOpen() {
  const now = Date.now();
  try {
    const last = parseInt(localStorage.getItem('myos_last_open') || '0', 10);
    if (now - last < 30 * 60 * 1000) return;
    localStorage.setItem('myos_last_open', String(now));
  } catch (e) { /* storage unavailable: fall through and log once per load */ }
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  track('app_open', { mode: standalone ? 'standalone' : 'browser' });
}

// Date utilities (dates are 'YYYY-MM-DD' strings in LA time)
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Bucket: overdue | today | tomorrow | week (through this Sunday) | later
function bucketOf(dateStr) {
  if (dateStr < today) return 'overdue';
  if (dateStr === today) return 'today';
  if (dateStr === addDays(today, 1)) return 'tomorrow';
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0 = Sun
  const sunday = addDays(today, dow === 0 ? 7 : 7 - dow);
  return dateStr <= sunday ? 'week' : 'later';
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
  if (dateStr.slice(0, 4) !== today.slice(0, 4)) opts.year = 'numeric';
  return new Intl.DateTimeFormat('en-US', opts).format(d);
}

function headerFor(dateStr) {
  if (!dateStr) return 'No date';
  if (dateStr === today) return 'Today';
  if (dateStr === addDays(today, 1)) return 'Tomorrow';
  return formatDate(dateStr);
}

// Group visible tasks by due date, in date order
function groupTasksByDate() {
  const groups = [];
  const undated = [];
  for (const task of tasks) {
    if (areaFilter && task.area !== areaFilter) continue;
    if (!inScope(task.area)) continue;
    if (!task.due_date) continue; // B43: undated tasks live in the Backlog section
    const last = groups[groups.length - 1];
    if (last && last.date === task.due_date) last.tasks.push(task);
    else groups.push({ date: task.due_date, tasks: [task] });
  }
  if (undated.length) groups.push({ date: null, tasks: undated });
  return groups;
}

function isExpanded(task) {
  return task.expanded ?? (task.due_date <= today);
}

// Load collapsed state from localStorage
function loadBriefCollapsedState() {
  try {
    const stored = localStorage.getItem('brief_collapsed_state');
    briefCollapsed = stored ? JSON.parse(stored) : {};
  } catch (e) {
    briefCollapsed = {};
  }
}

// Save collapsed state to localStorage
function saveBriefCollapsedState() {
  try {
    localStorage.setItem('brief_collapsed_state', JSON.stringify(briefCollapsed));
  } catch (e) {
    // Silently fail for localStorage errors
  }
}

// B42: this week's theme, pinned above everything; collapsible (remembered per device); hidden without a theme
function renderThemeCard() {
  if (!theme) return '';
  const row = (label, title, line) => (title || line)
    ? `<div class="theme-row"><span class="theme-label">${label}</span> ${title ? `<strong>${escapeHtml(title)}</strong>` : ''}${title && line ? ' · ' : ''}${line ? escapeHtml(line) : ''}</div>`
    : '';
  const body = themeCollapsed ? '' : `<div class="theme-body">
      ${row('Work', theme.work_title, theme.work_line)}
      ${row('Personal', theme.personal_title, theme.personal_line)}
      ${theme.through_line ? `<div class="theme-through"><em>${escapeHtml(theme.through_line)}</em></div>` : ''}
    </div>`;
  return `<div class="theme-card${themeCollapsed ? ' collapsed' : ''}">
    <div class="theme-header" role="button" tabindex="0"><span class="theme-title">This week</span><span class="theme-chevron">${themeCollapsed ? '▶' : '▼'}</span></div>
    ${body}
  </div>`;
}

// B37 P4: one chip per collector (Calendar, Mail, Chats); tap for details. Hidden until a collector exists.
function healthAge(h) {
  if (h === null || h === undefined) return 'never';
  if (h < 1) return Math.max(1, Math.round(h * 60)) + 'm ago';
  if (h < 48) return Math.round(h) + 'h ago';
  return Math.round(h / 24) + 'd ago';
}
const escAttr = (t) => escapeHtml(String(t)).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function renderHealthStrip() {
  const shown = sources.filter(s => s.status !== 'off');
  if (!shown.length) return '';
  const chips = sources.map(s => {
    const detail = s.status === 'off' ? 'not set up' : `last ok ${healthAge(s.age_hours)}${s.error ? ' · ' + s.error : ''}`;
    return `<button class="health-chip health-${escAttr(s.status)}" data-health-detail="${escAttr(s.label + ': ' + detail)}" title="${escAttr(detail)}"><span class="health-dot"></span>${escapeHtml(s.label)}</button>`;
  }).join('');
  return `<div class="health-strip">${chips}</div><div class="health-detail" id="health-detail"></div>`;
}

async function fetchBrief() {
  try {
    const res = await fetch('/api/brief');
    if (res.ok) {
      const data = await res.json();
      brief = data.brief;
      suggestions = data.suggestions || [];
      sources = Array.isArray(data.sources) ? data.sources : [];
      theme = data.theme && typeof data.theme === 'object' ? data.theme : null;
      if (data.today) today = data.today;
      // Collapse by default if brief is older than today
      if (brief && brief.date < today) {
        briefCollapsed[brief.date] = true;
      }
      saveBriefCollapsedState();
    }
  } catch (e) {
    console.error('Failed to fetch brief:', e);
  }
}

async function fetchTasks() {
  try {
    const res = await fetch('/api/tasks');
    if (res.status === 401) {
      window.location.href = '/login';
      return;
    }
    const data = await res.json();
    const prev = new Map(tasks.map(t => [t.id, t.expanded]));
    tasks = (data.tasks || []).map(t => ({ ...t, expanded: prev.get(t.id) }));
    completedToday = Array.isArray(data.completed_today) ? data.completed_today : [];
    droppedTasks = Array.isArray(data.dropped) ? data.dropped : [];
    today = data.today;
    render();
  } catch (e) {
    console.error('Failed to fetch tasks:', e);
  }
}

async function completeTask(taskId, task) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/complete`, { method: 'POST' });
    await fetchTasks();
    if (res.ok && task && task.ask_outcome) openOutcomeSheet(task);
    else showUndoToast(taskId, task);
  } catch (e) {
    console.error('Failed to complete task:', e);
  }
}

async function uncompleteTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}/uncomplete`, { method: 'POST' });
    await fetchTasks();
  } catch (e) {
    console.error('Failed to uncomplete task:', e);
  }
}

async function starTask(taskId) {
  try {
    await fetch(`/api/tasks/${taskId}/star`, { method: 'POST' });
    await fetchTasks();
  } catch (e) {
    console.error('Failed to star task:', e);
  }
}

async function snoozeTask(taskId, target) {
  try {
    const res = await fetch(`/api/tasks/${taskId}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: target }),
    });
    const data = await res.json();
    if (res.ok) {
      snoozeUndoMap[taskId] = data.previous;
      const task = tasks.find(t => t.id === taskId);
      const opts = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
      const newDateStr = target === 'tomorrow' ? addDays(today, 1) : getNextMondayLA();
      const newDateFormatted = new Intl.DateTimeFormat('en-US', opts).format(new Date(newDateStr + 'T00:00:00Z'));
      if (task && data.previous && shouldAskWhy(task, data.previous.due_date, newDateStr)) {
        openWhyLaterSheet(task, newDateStr, () => unsnoozeTask(taskId));
      } else {
        showSnoozeToast(taskId, newDateFormatted);
      }
      await fetchTasks();
    }
  } catch (e) {
    console.error('Failed to snooze task:', e);
  }
}

function unsnoozeTask(taskId) {
  const undo = snoozeUndoMap[taskId];
  if (!undo) return;
  fetch(`/api/tasks/${taskId}/unsnooze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(undo),
  }).then(() => fetchTasks()).catch(e => console.error('Failed to unsnooze:', e));
}

function getNextMondayLA() {
  const d = new Date(today + 'T00:00:00Z');
  const dow = d.getUTCDay();
  let daysUntilMonday = (1 - dow + 7) % 7;
  if (daysUntilMonday <= 1) daysUntilMonday += 7; // matches server
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return d.toISOString().slice(0, 10);
}

async function updateTaskPriority(taskId) {
  try {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    const priorities = [null, 'P0', 'P1', 'P2'];
    const currentIdx = priorities.indexOf(task.priority);
    const nextPriority = priorities[(currentIdx + 1) % priorities.length];

    const res = await fetch(`/api/tasks/${taskId}/priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: nextPriority }),
    });
    if (res.ok) {
      await fetchTasks();
    }
  } catch (e) {
    console.error('Failed to update priority:', e);
  }
}

async function createTask(title, dueDate, recurrence, priority, list, raw, explicit, backlog) {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // B34: adding from the Work scope tags the task work; Personal/All leave it untagged
      body: JSON.stringify({ title, due_date: dueDate, recurrence, priority, list, raw, explicit, area: scope === 'work' ? 'work' : null, ...(backlog ? { backlog: true } : {}) }),
    });
    if (res.ok) {
      const data = await res.json();
      await fetchTasks();
      if (data.ai_cleaned) {
        const dueFormatted = data.due_date ? formatDate(data.due_date) : (data.inbox ? 'Inbox' : 'Backlog');
        const priorityStr = data.priority || '–';
        showAiCleanupToast(data.id, data.title, dueFormatted, priorityStr);
      }
      return true;
    }
  } catch (e) {
    console.error('Failed to create task:', e);
  }
  return false;
}

async function acceptSuggestion(suggestionId, overrides) {
  try {
    const res = await fetch(`/api/suggestions/${suggestionId}/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(overrides || {}),
    });
    if (res.ok) {
      suggestions = suggestions.filter(s => s.id !== suggestionId);
      render();
      await fetchBrief();
      await fetchTasks();
      render();
      return true;
    }
  } catch (e) {
    console.error('Failed to accept suggestion:', e);
  }
  return false;
}

async function dismissSuggestion(suggestionId) {
  try {
    const res = await fetch(`/api/suggestions/${suggestionId}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (res.ok) {
      suggestions = suggestions.filter(s => s.id !== suggestionId);
      render();
      await fetchBrief();
      render();
      return true;
    }
  } catch (e) {
    console.error('Failed to dismiss suggestion:', e);
  }
  return false;
}

function showUndoToast(taskId, task) {
  if (undoToastTimeout) clearTimeout(undoToastTimeout);

  const toast = document.getElementById('undo-toast');
  if (toast) toast.remove();

  const newToast = document.createElement('div');
  newToast.id = 'undo-toast';
  newToast.className = 'undo-toast';
  newToast.innerHTML = `
    <span>${escapeHtml(task.title)} done</span>
    <button class="undo-btn">Undo</button>
  `;

  newToast.querySelector('.undo-btn').addEventListener('click', () => {
    uncompleteTask(taskId);
    newToast.remove();
  });

  document.body.appendChild(newToast);

  undoToastTimeout = setTimeout(() => {
    newToast.remove();
  }, 6000);
}

function showSnoozeToast(taskId, dateStr) {
  if (undoToastTimeout) clearTimeout(undoToastTimeout);

  const toast = document.getElementById('undo-toast');
  if (toast) toast.remove();

  const newToast = document.createElement('div');
  newToast.id = 'undo-toast';
  newToast.className = 'undo-toast';
  newToast.innerHTML = `
    <span>Snoozed to ${dateStr}</span>
    <button class="undo-btn">Undo</button>
  `;

  newToast.querySelector('.undo-btn').addEventListener('click', () => {
    unsnoozeTask(taskId);
    newToast.remove();
  });

  document.body.appendChild(newToast);

  undoToastTimeout = setTimeout(() => {
    newToast.remove();
  }, 6000);
}

function showAiCleanupToast(taskId, title, dueDate, priority) {
  if (undoToastTimeout) clearTimeout(undoToastTimeout);

  const toast = document.getElementById('undo-toast');
  if (toast) toast.remove();

  const newToast = document.createElement('div');
  newToast.id = 'undo-toast';
  newToast.className = 'undo-toast';
  newToast.innerHTML = `
    <span>Added: ${escapeHtml(title)} · ${dueDate} · ${priority}</span>
    <button class="undo-btn">Undo</button>
  `;

  newToast.querySelector('.undo-btn').addEventListener('click', () => {
    fetch(`/api/tasks/${taskId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    }).then(() => fetchTasks()).catch(e => console.error('Failed to delete task:', e));
    newToast.remove();
  });

  document.body.appendChild(newToast);

  undoToastTimeout = setTimeout(() => {
    newToast.remove();
  }, 6000);
}

function renderTaskRow(task) {
  const expanded = isExpanded(task);
  const stepCount = task.steps ? task.steps.length : 0;
  const completedStepCount = task.steps ? task.steps.filter(s => s.completed_at).length : 0;

  const html = `
    <div class="task-row" data-task-id="${task.id}">
      <div class="task-content">
        <div class="task-checkbox">
          <input type="checkbox" class="check-circle" data-task-id="${task.id}">
        </div>
        <div class="task-main" data-task-id="${task.id}">
          <div class="task-title">
            ${task.priority ? `<button class="priority-pill" data-task-id="${task.id}" title="Cycle priority">${task.priority}</button>` : `<button class="priority-pill priority-pill-ghost" data-task-id="${task.id}" title="Set priority">P–</button>`}
            <span class="title-text">${escapeHtml(task.title)}</span>
          </div>
          <div class="task-meta">
            <span class="list-name">${task.list}</span>
            ${task.area ? `<span class="area-tag" data-area="${task.area}" title="Filter by ${task.area}">${task.area}</span>` : ''}
            ${stepCount > 0 ? `<span class="step-count">${completedStepCount} of ${stepCount}</span>` : ''}
            ${task.due_date ? `<span class="due-date ${task.due_date < today ? 'overdue' : ''}">${formatDate(task.due_date)}</span>` : ''}
            ${task.recurrence ? `<span class="recurrence">↻</span>` : ''}
            ${task.notes ? `<span class="notes-indicator" title="Has notes">≡</span>` : ''}
          </div>
          ${expanded && stepCount > 0 ? renderSteps(task.steps, task.id) : ''}
        </div>
      </div>
      <div class="task-actions">
        <button class="snooze-btn" data-task-id="${task.id}" title="Snooze to tomorrow">⏭</button>
        <button class="star-btn ${task.starred ? 'starred' : ''}" data-task-id="${task.id}" title="Star">
          ${task.starred ? '★' : '☆'}
        </button>
        ${stepCount > 0 ? `<button class="expand-btn" data-task-id="${task.id}">${expanded ? '▼' : '▶'}</button>` : ''}
      </div>
    </div>
  `;

  return html;
}

// B4: collapsible "Completed today" with undo (newest first)
function renderCompletedToday() {
  const list = completedToday.filter(c => (!areaFilter || c.area === areaFilter) && inScope(c.area));
  if (list.length === 0) return '';
  let html = `<div class="done-section"><button type="button" class="done-header" id="done-toggle"><span>Completed today (${list.length})</span><span>${doneOpen ? '▼' : '▶'}</span></button>`;
  if (doneOpen) {
    html += '<div class="done-list">';
    for (const c of list) {
      const d = new Date(c.completed_at);
      const time = isNaN(d) ? '' : d.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).replace(' AM', 'am').replace(' PM', 'pm');
      html += `<div class="done-row">
        <span class="done-check">✓</span>
        <span class="done-title">${escapeHtml(c.title)}</span>
        ${c.recurring ? '<span class="recurrence">↻</span>' : ''}
        <span class="done-time">${time}</span>
        ${c.can_undo ? `<button type="button" class="done-undo" data-task-id="${escapeHtml(c.task_id)}">Undo</button>` : ''}
      </div>`;
    }
    html += '</div>';
  }
  return html + '</div>';
}

// B30: Won't do list (last 30 days) with Restore
function renderDroppedList() {
  const list = droppedTasks.filter(t => (!areaFilter || t.area === areaFilter) && inScope(t.area));
  if (list.length === 0) return '<div class="no-tasks">Nothing marked won\'t do in the last 30 days</div>';
  let html = '<div class="task-group"><div class="group-header">Won\'t do · last 30 days</div>';
  for (const t of list) {
    const when = t.dropped_at ? formatDate(t.dropped_at.slice(0, 10)) : '';
    const why = wontDoReason(t.notes);
    html += `<div class="task-row dropped-row">
      <div class="task-content"><div class="dropped-main">
        <div class="task-title"><span class="title-text">${escapeHtml(t.title)}</span></div>
        <div class="task-meta">
          ${t.area ? `<span class="area-tag" data-area="${escapeHtml(t.area)}">${escapeHtml(t.area)}</span>` : ''}
          <span>${when}</span>
          ${t.recurrence ? '<span class="recurrence">↻</span>' : ''}
          ${why ? `<span class="dropped-why">${escapeHtml(why)}</span>` : ''}
        </div>
      </div></div>
      <button class="sheet-btn restore-btn" data-task-id="${t.id}">Restore</button>
    </div>`;
  }
  return html + '</div>';
}

function renderSteps(steps, parentId) {
  return `
    <div class="steps-container">
      ${steps.map(step => `
        <div class="step-row">
          <input type="checkbox" class="step-checkbox" data-task-id="${step.id}" ${step.completed_at ? 'checked' : ''}>
          <span class="step-text ${step.completed_at ? 'completed' : ''}">${escapeHtml(step.title)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Tiny safe markdown renderer: escape HTML first, then support ## heading, - bullet, **bold**, paragraphs
function renderMarkdown(text) {
  if (!text) return '';
  // Escape first; only ## headings, - bullets (2-space nesting), **bold**, paragraphs
  const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let depth = 0; // number of open <ul>
  const closeTo = (d) => { while (depth > d) { out.push('</ul>'); depth--; } };

  for (const line of text.split('\n')) {
    const bullet = line.match(/^(\s*)- (.*)$/);
    if (bullet) {
      const want = Math.floor(bullet[1].length / 2) + 1;
      while (depth < want) { out.push('<ul>'); depth++; }
      closeTo(want);
      out.push('<li>' + inline(bullet[2]) + '</li>');
      continue;
    }
    closeTo(0);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const heading = trimmed.match(/^##\s+(.*)$/);
    out.push(heading ? '<h2>' + inline(heading[1]) + '</h2>' : '<p>' + inline(trimmed) + '</p>');
  }
  closeTo(0);
  return out.join('');
}

function render() {
  const app = document.getElementById('app');
  const groups = groupTasksByDate();

  let html = '<div class="app-container">';
  // Title, brief and suggestions scroll with the page; only quick-add + filters stay pinned
  html += '<section class="top-section">';
  html += '<h1>Planned</h1>';

  html += renderThemeCard();
  html += renderHealthStrip();

  // Brief card
  if (brief) {
    const isCollapsed = briefCollapsed[brief.date] || false;
    const updated = new Date(brief.created_at);
    const timeLabel = isNaN(updated) ? '' : ' · ' + updated.toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).replace(' AM', 'am').replace(' PM', 'pm');
    const briefLabel = (brief.date < today ? 'Last brief · ' : 'Brief · ') + formatDate(brief.date) + timeLabel;
    html += `<div class="brief-card">
      <div class="brief-header" data-brief-date="${brief.date}">
        <span class="brief-title">${briefLabel}</span>
        <span class="brief-chevron ${isCollapsed ? '' : 'open'}">${isCollapsed ? '▶' : '▼'}</span>
      </div>
      ${!isCollapsed ? `<div class="brief-body">${renderMarkdown(brief.body_md)}</div>` : ''}
    </div>`;
  }

  // Suggestions section
  if (suggestions.length > 0) {
    html += `<div class="suggestions-section">
      <div class="suggestions-header">Suggested (${suggestions.length})</div>
      <div class="suggestions-list">`;

    for (const sugg of suggestions) {
      const dueDateLabel = sugg.due_date ? formatDate(sugg.due_date) : 'No date';
      const sourceLabel = sugg.source ? (sugg.source_detail ? `${sugg.source} · ${sugg.source_detail}` : sugg.source) : '';
      html += `<div class="suggestion-row" data-sugg-id="${sugg.id}">
        <div class="suggestion-content">
          <div class="suggestion-title">${escapeHtml(sugg.title)}</div>
          <div class="suggestion-meta">
            <span class="suggestion-due">${dueDateLabel}</span>
            ${sugg.priority ? `<span class="suggestion-priority">${sugg.priority}</span>` : ''}
            ${sugg.area ? `<span class="area-tag">${escapeHtml(sugg.area)}</span>` : ''}
            ${sourceLabel ? `<span class="suggestion-source">${escapeHtml(sourceLabel)}</span>` : ''}
          </div>
        </div>
        <div class="suggestion-actions">
          <button class="suggestion-accept-btn" data-sugg-id="${sugg.id}" title="Accept">✓</button>
          <button class="suggestion-dismiss-btn" data-sugg-id="${sugg.id}" title="Dismiss">✗</button>
        </div>
      </div>`;
    }

    html += '</div></div>';
  }

  html += '</section>';
  html += '<header class="app-header">';
  html += '<div class="quick-add-container">';
  html += '<input type="text" id="quick-add-input" class="quick-add-input" placeholder="Add a task — e.g. Grocery tomorrow weekly p0">';
  html += '<div id="quick-add-preview" class="quick-add-preview"></div>';
  html += '</div>';
  html += '<div class="filter-chips">';
  if (areaFilter) html += `<button class="chip active area-filter-chip" data-clear-area="1">${areaFilter} ✕</button>`;
  for (const [key, label] of [['all', 'All'], ['personal', 'Personal'], ['work', 'Work']]) {
    html += `<button class="chip ${scope === key && selectedFilter !== 'dropped' ? 'active' : ''}" data-scope="${key}">${label}</button>`;
  }
  html += '</div>';
  html += '</header>';

  html += '<div class="tasks-list">';

  if (selectedFilter !== 'dropped') html += renderInbox();
  if (selectedFilter === 'dropped') {
    html += renderDroppedList();
  } else if (groups.length === 0 && !inboxTasks().length) {
    html += '<div class="no-tasks">Nothing here 🎉</div>';
  } else {
    for (const g of groups) {
      html += `<div class="task-group"><div class="group-header ${g.date && g.date < today ? 'overdue' : ''}">${headerFor(g.date)}</div>`;
      for (const task of g.tasks) html += renderTaskRow(task);
      html += '</div>';
    }
  }

  if (selectedFilter !== 'dropped') {
    html += renderCompletedToday();
    html += renderBacklog();
    const nDropped = droppedTasks.filter(t => inScope(t.area)).length;
    if (nDropped) html += `<div class="done-section"><button type="button" class="done-header" data-filter="dropped"><span>Won't do (${nDropped})</span><span>▶</span></button></div>`;
  }

  html += '</div>';
  html += '</div>';

  app.innerHTML = html;
  attachEventListeners();
}

function attachEventListeners() {
  // Brief header toggle
  const bt = document.getElementById('backlog-toggle');
  if (bt) bt.addEventListener('click', () => {
    backlogOpen = !backlogOpen;
    if (backlogOpen) track('view', { name: 'backlog' });
    render();
  });
  document.querySelectorAll('.backlog-date').forEach(inp => {
    inp.addEventListener('change', () => { if (inp.value) scheduleTask(inp.dataset.scheduleId, inp.value); });
  });
  document.querySelectorAll('[data-backlog-open]').forEach(b => {
    b.addEventListener('click', () => { const t = tasks.find(x => x.id === b.dataset.backlogOpen); if (t) openEditSheet(t); });
  });

  document.querySelectorAll('.theme-header').forEach(h => {
    h.addEventListener('click', () => {
      themeCollapsed = !themeCollapsed;
      try { localStorage.setItem('myos_theme_collapsed', themeCollapsed ? '1' : '0'); } catch (e) { /* ignore */ }
      track('view', { name: 'theme_card', state: themeCollapsed ? 'collapsed' : 'expanded' });
      render();
    });
  });

  document.querySelectorAll('.health-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const el = document.getElementById('health-detail');
      if (el) el.textContent = el.textContent === chip.dataset.healthDetail ? '' : chip.dataset.healthDetail;
      track('view', { name: 'health_chip' });
    });
  });

  document.querySelectorAll('.brief-header').forEach(header => {
    header.addEventListener('click', () => {
      const briefDate = header.dataset.briefDate;
      briefCollapsed[briefDate] = !briefCollapsed[briefDate];
      if (!briefCollapsed[briefDate]) track('view', { name: 'brief' });
      saveBriefCollapsedState();
      render();
    });
  });

  // Suggestion accept buttons
  document.querySelectorAll('.suggestion-accept-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const suggId = btn.dataset.suggId;
      await acceptSuggestion(suggId);
    });
  });

  // Suggestion dismiss buttons
  document.querySelectorAll('.suggestion-dismiss-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const suggId = btn.dataset.suggId;
      await dismissSuggestion(suggId);
    });
  });

  // Filter buttons
  document.querySelectorAll('[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      selectedFilter = btn.dataset.filter;
      track('view', { name: selectedFilter });
      render();
    });
  });

  // B32: Personal / Work scope chips (remembered); tapping one also leaves the Won't do view
  document.querySelectorAll('.chip[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      scope = btn.dataset.scope;
      selectedFilter = 'all';
      try { localStorage.setItem('myos_scope', scope); } catch (e) { /* ignore */ }
      track('view', { name: 'scope:' + scope });
      render();
    });
  });

  // Area filter: tap an area tag to filter, tap the chip to clear
  document.querySelectorAll('.area-tag[data-area]').forEach(tag => {
    tag.addEventListener('click', (e) => {
      e.stopPropagation();
      areaFilter = tag.dataset.area;
      track('view', { name: 'area:' + areaFilter });
      render();
    });
  });
  document.querySelectorAll('[data-clear-area]').forEach(btn => {
    btn.addEventListener('click', () => { areaFilter = null; render(); });
  });

  // Quick-add input
  const quickAddInput = document.getElementById('quick-add-input');
  const quickAddPreview = document.getElementById('quick-add-preview');
  if (quickAddInput) {
    quickAddInput.addEventListener('input', (e) => {
      const text = e.target.value.trim();
      if (text && typeof parseQuickAdd === 'function') {
        const parsed = parseQuickAdd(text, today);
        // No date typed -> Inbox (no guessing); a repeat without a date starts today
        const dateFormatted = parsed.backlog ? 'Backlog' : (parsed.explicit && parsed.explicit.due_date) || parsed.recurrence ? formatDate(parsed.due_date) : 'Inbox';
        let preview = `${dateFormatted}`;
        if (parsed.recurrence) preview += ` · ${parsed.recurrence}`;
        if (parsed.priority) preview += ` · ${parsed.priority}`;
        quickAddPreview.textContent = preview;
      } else {
        quickAddPreview.textContent = '';
      }
    });

    quickAddInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const text = e.target.value.trim();
        if (text && typeof parseQuickAdd === 'function') {
          const parsed = parseQuickAdd(text, today);
          if (parsed.title) {
            e.target.disabled = true;
            const preview = document.getElementById('quick-add-preview');
            if (preview) preview.textContent = 'Adding…';

            createTask(parsed.title, parsed.explicit && parsed.explicit.due_date ? parsed.due_date : null, parsed.recurrence, parsed.priority, parsed.list, text, parsed.explicit, parsed.backlog).then(() => {
              const input = document.getElementById('quick-add-input');
              if (input) { input.value = ''; input.disabled = false; input.focus(); }
              const previewEl = document.getElementById('quick-add-preview');
              if (previewEl) previewEl.textContent = '';
            });
          }
        }
      }
    });
  }

  // Check circles
  document.querySelectorAll('.check-circle').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const taskId = e.target.dataset.taskId;
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        e.target.closest('.task-row').classList.add('completing');
        setTimeout(() => completeTask(taskId, task), 300);
      }
    });
  });

  // Step checkboxes
  document.querySelectorAll('.step-checkbox').forEach(checkbox => {
    checkbox.addEventListener('change', (e) => {
      const taskId = e.target.dataset.taskId;
      const checked = e.target.checked;
      fetch(`/api/tasks/${taskId}/${checked ? 'complete' : 'uncomplete'}`, { method: 'POST' })
        .then(fetchTasks)
        .catch(err => console.error('Failed to toggle step:', err));
    });
  });

  // Snooze buttons: tap = tomorrow, long-press or right-click = next week
  document.querySelectorAll('.snooze-btn').forEach(btn => {
    const taskId = btn.dataset.taskId;
    let pressTimer = null;
    let handled = false;

    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      handled = false;
      pressTimer = setTimeout(() => {
        handled = true;
        snoozeTask(taskId, 'nextweek');
      }, 500);
    });
    const cancel = () => clearTimeout(pressTimer);
    btn.addEventListener('pointerleave', cancel);
    btn.addEventListener('pointercancel', cancel);
    btn.addEventListener('pointerup', (e) => {
      if (e.button !== 0) return;
      clearTimeout(pressTimer);
      if (!handled) {
        handled = true;
        snoozeTask(taskId, 'tomorrow');
      }
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      clearTimeout(pressTimer);
      if (!handled) {
        handled = true;
        snoozeTask(taskId, 'nextweek');
      }
    });
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });

  // Priority pills
  document.querySelectorAll('.priority-pill').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      updateTaskPriority(taskId);
    });
  });

  // Star buttons
  document.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      starTask(taskId);
    });
  });

  // Expand buttons
  document.querySelectorAll('.expand-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const taskId = btn.dataset.taskId;
      const task = tasks.find(t => t.id === taskId);
      if (task) {
        task.expanded = !isExpanded(task);
        render();
      }
    });
  });

  // Completed today: toggle + undo
  const doneToggle = document.getElementById('done-toggle');
  if (doneToggle) doneToggle.addEventListener('click', () => {
    doneOpen = !doneOpen;
    try { localStorage.setItem('myos_done_open', doneOpen ? '1' : '0'); } catch (e) { /* ignore */ }
    if (doneOpen) track('view', { name: 'completed_today' });
    render();
  });
  document.querySelectorAll('.done-undo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.disabled = true;
      uncompleteTask(btn.dataset.taskId);
    });
  });

  // Restore from the Won't do list
  document.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      btn.disabled = true;
      restoreTask(btn.dataset.taskId, null);
    });
  });

  // Task row click opens the edit sheet (chevron expands steps); long-press (or right-click) = Won't do
  document.querySelectorAll('.task-main').forEach(elem => {
    let timer = null, fired = false, sx = 0, sy = 0;
    const skipTarget = (e) => e.target.closest('.priority-pill, .step-checkbox, .step-text, .area-tag, a');
    const taskOf = () => tasks.find(t => t.id === elem.dataset.taskId);
    const cancel = () => { clearTimeout(timer); timer = null; };
    const fire = () => {
      cancel();
      if (fired) return;
      fired = true;
      const task = taskOf();
      if (!task) return;
      try { if (navigator.vibrate) navigator.vibrate(15); } catch (err) { /* ignore */ }
      openWontDoSheet(task);
    };
    elem.addEventListener('pointerdown', (e) => {
      fired = false;
      if (e.button !== 0 || skipTarget(e)) return;
      sx = e.clientX; sy = e.clientY;
      cancel();
      timer = setTimeout(fire, 550);
    });
    elem.addEventListener('pointermove', (e) => {
      if (timer && (Math.abs(e.clientX - sx) > 10 || Math.abs(e.clientY - sy) > 10)) cancel();
    });
    elem.addEventListener('pointerup', cancel);
    elem.addEventListener('pointercancel', cancel);
    elem.addEventListener('pointerleave', cancel);
    elem.addEventListener('contextmenu', (e) => {
      if (skipTarget(e)) return;
      e.preventDefault();
      fire();
    });
    elem.addEventListener('click', (e) => {
      if (fired) { fired = false; e.preventDefault(); return; }
      if (skipTarget(e)) return;
      const task = taskOf();
      if (task) openEditSheet(task);
    });
  });
}

// Notes: escape first, then linkify URLs; line breaks via CSS (white-space: pre-wrap)
function renderNotes(text) {
  if (!text) return '';
  return escapeHtml(text).replace(/https?:\/\/[^\s<>"']+/g, (m) => {
    const trail = (m.match(/[.,;:!?)\]]+$/) || [''])[0];
    const url = trail ? m.slice(0, -trail.length) : m;
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>${trail}`;
  });
}

// ---- Edit sheet ----
const SHEET_RECURRENCES = [[null, 'None'], ['daily', 'Daily'], ['weekdays', 'Weekdays'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly']];
const SHEET_PRIORITIES = [[null, 'None'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['P3', 'P3']];
const SHEET_AREAS = [[null, 'None'], ...AREAS.map(a => [a, a])];
const SHEET_LISTS = [['Tasks', 'Tasks'], ['Birthdays', 'Birthdays']];
let sheetState = null;

function sheetChips(name, options, selected) {
  return `<div class="sheet-chips" data-group="${name}">` + options.map(([val, label]) =>
    `<button type="button" class="sheet-chip ${val === selected ? 'active' : ''}" data-group="${name}" data-value="${val === null ? '' : val}">${label}</button>`
  ).join('') + '</div>';
}

function closeEditSheet() {
  const el = document.getElementById('edit-sheet-root');
  if (el) el.remove();
  document.body.classList.remove('sheet-open');
  document.removeEventListener('keydown', sheetKeydown);
  sheetState = null;
}

function sheetKeydown(e) {
  if (e.key === 'Escape') closeEditSheet();
}

function openEditSheet(task) {
  closeEditSheet();
  sheetState = {
    id: task.id,
    title: task.title,
    notes: task.notes || '',
    due_date: task.due_date || '', // '' = backlog (B43) or Inbox
    inbox: !!task.inbox && !task.due_date,
    toBacklog: false,
    recurrence: task.recurrence || null,
    priority: task.priority || null,
    list: task.list,
    area: task.area || null,
    confirmingDelete: false,
    editingNotes: !task.notes,
    original: task,
  };
  const root = document.createElement('div');
  root.id = 'edit-sheet-root';
  document.body.appendChild(root);
  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', sheetKeydown);
  renderEditSheet();
  track('sheet_opened', {}, task.id);
}

function renderEditSheet() {
  const root = document.getElementById('edit-sheet-root');
  if (!root || !sheetState) return;
  const st = sheetState;
  const notesBlock = st.editingNotes
    ? `<textarea id="sheet-notes" class="sheet-input sheet-textarea" rows="5" placeholder="Notes">${escapeHtml(st.notes)}</textarea>`
    : `<div id="sheet-notes-view" class="sheet-notes-view" title="Tap to edit">${renderNotes(st.notes)}</div>`;
  root.innerHTML = `
    <div class="sheet-backdrop"></div>
    <div class="sheet" role="dialog" aria-label="Edit task">
      <div class="sheet-handle"></div>
      <label class="sheet-label">Title</label>
      <input id="sheet-title" class="sheet-input" type="text" maxlength="200" value="${escapeHtml(st.title).replace(/"/g, '&quot;')}">
      <label class="sheet-label">Notes${!st.editingNotes ? ' <button type="button" class="sheet-link-btn" id="sheet-edit-notes">Edit</button>' : ''}</label>
      ${notesBlock}
      <label class="sheet-label">Due date${(st.due_date || (st.inbox && !st.toBacklog)) && !st.recurrence ? ' <button type="button" class="sheet-link-btn" id="sheet-to-backlog">Move to backlog</button>' : ''}</label>
      <input id="sheet-due" class="sheet-input" type="date" value="${escAttr(st.due_date)}">
      ${st.due_date ? '' : st.inbox && !st.toBacklog ? '<div class="sheet-hint">In the Inbox. Pick a date, or move it to the backlog.</div>' : '<div class="sheet-hint">In the backlog (no date). Pick a date to schedule it.</div>'}
      <label class="sheet-label">Repeat</label>
      ${sheetChips('recurrence', SHEET_RECURRENCES, st.recurrence)}
      <label class="sheet-label">Priority</label>
      ${sheetChips('priority', SHEET_PRIORITIES, st.priority)}
      <label class="sheet-label">Area</label>
      ${sheetChips('area', SHEET_AREAS, st.area)}
      <label class="sheet-label">List</label>
      ${sheetChips('list', SHEET_LISTS, st.list)}
      <div class="sheet-quick">
        <button type="button" class="sheet-btn" id="sheet-complete">✓ Complete</button>
        <button type="button" class="sheet-btn" id="sheet-wontdo">Won't do</button>
      </div>
      <div id="sheet-error" class="sheet-error"></div>
      <div class="sheet-actions">
        ${st.confirmingDelete
          ? `<span class="sheet-confirm-text">Delete this task?</span>
             <button type="button" class="sheet-btn" id="sheet-cancel-delete">Keep</button>
             <button type="button" class="sheet-btn sheet-btn-danger" id="sheet-confirm-delete">Delete</button>`
          : `<button type="button" class="sheet-btn sheet-btn-danger-ghost" id="sheet-delete">Delete</button>
             <span class="sheet-spacer"></span>
             <button type="button" class="sheet-btn" id="sheet-cancel">Cancel</button>
             <button type="button" class="sheet-btn sheet-btn-primary" id="sheet-save">Save</button>`}
      </div>
    </div>`;

  root.querySelector('.sheet-backdrop').addEventListener('click', closeEditSheet);
  // Keep typed values when re-rendering for chip changes
  const syncText = () => {
    const t = document.getElementById('sheet-title'); if (t) st.title = t.value;
    const n = document.getElementById('sheet-notes'); if (n) st.notes = n.value;
    const d = document.getElementById('sheet-due'); if (d && d.value) st.due_date = d.value;
  };
  root.querySelectorAll('.sheet-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      syncText();
      st[btn.dataset.group] = btn.dataset.value === '' ? null : btn.dataset.value;
      renderEditSheet();
    });
  });
  const editNotes = document.getElementById('sheet-edit-notes');
  const notesView = document.getElementById('sheet-notes-view');
  const startEditNotes = () => { syncText(); st.editingNotes = true; renderEditSheet(); const n = document.getElementById('sheet-notes'); if (n) n.focus(); };
  if (editNotes) editNotes.addEventListener('click', startEditNotes);
  if (notesView) notesView.addEventListener('click', (e) => { if (!e.target.closest('a')) startEditNotes(); });

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.addEventListener('click', fn); };
  on('sheet-cancel', closeEditSheet);
  on('sheet-complete', () => { const t = st.original; closeEditSheet(); completeTask(t.id, t); });
  on('sheet-wontdo', () => { const t = st.original; closeEditSheet(); openWontDoSheet(t); });
  on('sheet-delete', () => { syncText(); st.confirmingDelete = true; renderEditSheet(); });
  on('sheet-to-backlog', () => { syncText(); st.due_date = ''; st.toBacklog = true; renderEditSheet(); });
  on('sheet-cancel-delete', () => { st.confirmingDelete = false; renderEditSheet(); });
  on('sheet-confirm-delete', async () => {
    try {
      const res = await fetch(`/api/tasks/${st.id}`, { method: 'DELETE' });
      if (res.ok) { closeEditSheet(); await fetchTasks(); return; }
    } catch (e) { console.error('Failed to delete task:', e); }
    sheetError('Could not delete. Try again.');
  });
  on('sheet-save', async () => {
    syncText();
    const title = st.title.trim();
    if (!title) { sheetError('Title is required'); return; }
    const o = st.original;
    const patch = {};
    if (title !== o.title) patch.title = title;
    if ((st.notes.trim() ? st.notes : null) !== (o.notes || null)) patch.notes = st.notes;
    if (!st.due_date && st.recurrence) { sheetError('A repeating task needs a due date'); return; }
    if (!st.due_date && (o.due_date || st.toBacklog)) patch.backlog = true; // B43 (and Inbox -> backlog)
    else if (st.due_date && st.due_date !== o.due_date) patch.due_date = st.due_date;
    if (st.recurrence !== (o.recurrence || null)) patch.recurrence = st.recurrence;
    if (st.priority !== (o.priority || null)) patch.priority = st.priority;
    if (st.list !== o.list) patch.list = st.list;
    if (st.area !== (o.area || null)) patch.area = st.area;
    if (Object.keys(patch).length === 0) { closeEditSheet(); return; }
    try {
      const res = await fetch(`/api/tasks/${st.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        closeEditSheet();
        await fetchTasks();
        if (patch.due_date && shouldAskWhy({ recurrence: st.recurrence || o.recurrence }, o.due_date, patch.due_date)) {
          openWhyLaterSheet(o, patch.due_date, null);
        }
        return;
      }
      const data = await res.json().catch(() => ({}));
      sheetError(data.error || 'Could not save');
    } catch (e) {
      console.error('Failed to save task:', e);
      sheetError('Could not save. Try again.');
    }
  });
}

function sheetError(msg) {
  const el = document.getElementById('sheet-error');
  if (el) el.textContent = msg;
}

// ---- Prompt sheets (B28 why-later, B29 outcome, B30 won't do) ----
// The action is saved first (except Won't do, where a chip IS the action); prompts only add context and are always skippable.
const LATER_REASONS = [['no_time', 'No time'], ['waiting', 'Waiting on someone'], ['not_important', 'Not important now'], ['blocked', 'Blocked']];
const DROP_REASONS = [['not_worth_it', 'Not worth it'], ['someone_else', 'Someone else did it'], ['overtaken', 'Overtaken by events'], ['changed_mind', 'Changed my mind'], ['duplicate', 'Duplicate']];
let promptState = null;

function closePromptSheet() {
  if (promptState && promptState.timer) clearTimeout(promptState.timer);
  const el = document.getElementById('prompt-sheet-root');
  if (el) el.remove();
  document.removeEventListener('keydown', promptKeydown);
  if (!document.getElementById('edit-sheet-root')) document.body.classList.remove('sheet-open');
  promptState = null;
}

function promptKeydown(e) {
  if (e.key === 'Escape' && promptState) { const cfg = promptState.cfg; closePromptSheet(); if (cfg.onSkip) cfg.onSkip(); }
}

// cfg: { title, subtitle, chips: [[code, label]], placeholder, segment: {options, value}, autoDismissMs,
//        saveLabel, saveNeedsText, skipLabel, autofocus, onChoose(code, text, segment) -> Promise<bool>, onSkip(), undoLabel, onUndo() }
function openPromptSheet(cfg) {
  closePromptSheet();
  const root = document.createElement('div');
  root.id = 'prompt-sheet-root';
  document.body.appendChild(root);
  document.body.classList.add('sheet-open');
  document.addEventListener('keydown', promptKeydown);
  promptState = { cfg, segment: cfg.segment ? cfg.segment.value : null, busy: false, timer: null, openedAt: Date.now() };
  renderPromptSheet();
  if (cfg.autoDismissMs) {
    promptState.timer = setTimeout(() => { if (promptState && promptState.cfg === cfg) { closePromptSheet(); if (cfg.onSkip) cfg.onSkip(); } }, cfg.autoDismissMs);
  }
  if (cfg.autofocus) { const i = document.getElementById('prompt-text'); if (i) i.focus(); }
}

// Any touch or typing inside the sheet stops the auto-dismiss
function holdPromptSheet() {
  if (!promptState || !promptState.timer) return;
  clearTimeout(promptState.timer);
  promptState.timer = null;
  const bar = document.querySelector('.prompt-timer');
  if (bar) bar.remove();
}

function renderPromptSheet() {
  const root = document.getElementById('prompt-sheet-root');
  if (!root || !promptState) return;
  const st = promptState, cfg = st.cfg;
  const typed = document.getElementById('prompt-text');
  const text = typed ? typed.value : '';
  const seg = cfg.segment ? `<div class="sheet-chips prompt-segment">` + cfg.segment.options.map(([v, l]) =>
    `<button type="button" class="sheet-chip ${v === st.segment ? 'active' : ''}" data-seg="${v}">${l}</button>`).join('') + '</div>' : '';
  const chips = (cfg.chips || []).length ? `<div class="sheet-chips prompt-chips">` + cfg.chips.map(([v, l]) =>
    `<button type="button" class="sheet-chip prompt-chip" data-code="${v}">${l}</button>`).join('') + '</div>' : '';
  root.innerHTML = `
    <div class="sheet-backdrop prompt-backdrop"></div>
    <div class="sheet prompt-sheet" role="dialog" aria-label="${escapeHtml(cfg.title)}">
      <div class="sheet-handle"></div>
      <div class="prompt-title">${escapeHtml(cfg.title)}</div>
      ${cfg.subtitle ? `<div class="prompt-sub">${escapeHtml(cfg.subtitle)}</div>` : ''}
      ${seg}
      ${chips}
      <div class="prompt-row">
        <input id="prompt-text" class="sheet-input" type="text" maxlength="${cfg.maxLength || 200}" placeholder="${escapeHtml(cfg.placeholder || 'Anything else?')}" value="${escapeHtml(text).replace(/"/g, '&quot;')}" enterkeyhint="done">
        <button type="button" class="sheet-btn sheet-btn-primary" id="prompt-save">${escapeHtml(cfg.saveLabel || 'Save')}</button>
      </div>
      <div id="prompt-error" class="sheet-error"></div>
      <div class="sheet-actions prompt-actions">
        ${cfg.onUndo ? `<button type="button" class="sheet-btn prompt-link" id="prompt-undo">${escapeHtml(cfg.undoLabel || 'Undo')}</button>` : ''}
        <span class="sheet-spacer"></span>
        <button type="button" class="sheet-btn prompt-link" id="prompt-skip">${escapeHtml(cfg.skipLabel || 'Skip')}</button>
      </div>
      ${st.timer ? `<div class="prompt-timer" style="animation-duration:${cfg.autoDismissMs}ms"></div>` : ''}
    </div>`;

  const sheet = root.querySelector('.prompt-sheet');
  sheet.addEventListener('pointerdown', holdPromptSheet);
  sheet.addEventListener('focusin', holdPromptSheet);
  sheet.addEventListener('keydown', holdPromptSheet);
  const skip = () => { if (st.busy) return; closePromptSheet(); if (cfg.onSkip) cfg.onSkip(); };
  // Ignore a backdrop tap right after opening (the finger lifting from a long-press)
  root.querySelector('.prompt-backdrop').addEventListener('click', () => { if (Date.now() - st.openedAt > 400) skip(); });
  document.getElementById('prompt-skip').addEventListener('click', skip);
  const undo = document.getElementById('prompt-undo');
  if (undo) undo.addEventListener('click', () => { if (st.busy) return; closePromptSheet(); cfg.onUndo(); });
  root.querySelectorAll('[data-seg]').forEach(b => b.addEventListener('click', () => { st.segment = b.dataset.seg; renderPromptSheet(); }));

  const choose = async (code) => {
    if (st.busy) return;
    const t = (document.getElementById('prompt-text') || {}).value || '';
    if (!code && cfg.saveNeedsText && !t.trim()) { const i = document.getElementById('prompt-text'); if (i) i.focus(); return; }
    st.busy = true;
    sheet.classList.add('busy');
    let ok = false;
    try { ok = await cfg.onChoose(code, t.trim(), st.segment); } catch (e) { console.error('prompt failed', e); }
    if (promptState !== st) return; // closed meanwhile
    if (ok) { closePromptSheet(); return; }
    st.busy = false;
    sheet.classList.remove('busy');
    const err = document.getElementById('prompt-error');
    if (err) err.textContent = 'Could not save. Try again.';
  };
  root.querySelectorAll('.prompt-chip').forEach(b => b.addEventListener('click', () => choose(b.dataset.code)));
  document.getElementById('prompt-save').addEventListener('click', () => choose(null));
  document.getElementById('prompt-text').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); choose(null); } });
}

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

// B28: ask only for one-off tasks whose date moved later (not recurring, not undated, not earlier)
function shouldAskWhy(task, oldDue, newDue) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  // Recurring tasks ask too (product decision): a skipped workout says something
  return !!task && re.test(oldDue || '') && re.test(newDue || '') && newDue > oldDue;
}

function openWhyLaterSheet(task, newDate, onUndo) {
  openPromptSheet({
    title: 'Why later?',
    subtitle: `${task.title} → ${formatDate(newDate)}`,
    chips: LATER_REASONS,
    autoDismissMs: 8000,
    saveNeedsText: true,
    onChoose: async (code, text) => {
      const body = { kind: 'later' };
      if (code) body.reason = code;
      if (text) body.text = text;
      const r = await postJson(`/api/tasks/${task.id}/signal`, body);
      if (r.ok) fetchTasks();
      return r.ok;
    },
    onUndo: onUndo || null,
  });
}

// B29: placeholder from the kind of task
function outcomePlaceholder(title) {
  const t = String(title || '').toLowerCase();
  if (/\b(call|phone|ring|ask|email|text|message|reply|follow up|follow-up|check with)\b/.test(t)) return 'What did they say?';
  if (/\b(appointment|appt|doctor|dentist|visit|meeting|interview)\b/.test(t)) return 'How did it go?';
  if (/\b(decide|decision|choose|pick)\b/.test(t)) return 'What did you decide?';
  return 'What happened?';
}

function openOutcomeSheet(task) {
  openPromptSheet({
    title: 'Outcome?',
    subtitle: task.title,
    placeholder: outcomePlaceholder(task.title),
    maxLength: 500,
    saveNeedsText: true,
    autofocus: true,
    onChoose: async (_code, text) => {
      const r = await postJson(`/api/tasks/${task.id}/signal`, { kind: 'outcome', text });
      if (r.ok) fetchTasks();
      return r.ok;
    },
    onUndo: () => uncompleteTask(task.id),
  });
}

// B30: Won't do. A reason chip (or the Won't do button) performs the drop; Cancel does nothing.
function openWontDoSheet(task) {
  const recurring = !!task.recurrence;
  const run = async (code, text, series) => {
    const body = {};
    if (code) body.reason = code;
    if (text) body.text = text;
    if (recurring) body.series = series || 'skip';
    const r = await postJson(`/api/tasks/${task.id}/drop`, body);
    if (!r.ok) return false;
    await fetchTasks();
    const prev = r.data && r.data.previous;
    const label = r.data && r.data.skipped ? `Skipped to ${formatDate(r.data.task.due_date)}` : "Marked won't do";
    showActionToast(label, () => restoreTask(task.id, r.data && r.data.skipped ? prev : null));
    return true;
  };
  openPromptSheet({
    title: "Won't do",
    subtitle: task.title,
    segment: recurring ? { options: [['skip', 'Skip this one'], ['stop', 'Stop the series']], value: 'skip' } : null,
    chips: DROP_REASONS,
    placeholder: 'Why? (optional)',
    saveLabel: "Won't do",
    skipLabel: 'Cancel',
    onChoose: run,
  });
}

async function restoreTask(taskId, previous) {
  try {
    await postJson(`/api/tasks/${taskId}/restore`, previous ? { due_date: previous.due_date, snoozed_from: previous.snoozed_from || null } : {});
  } catch (e) { console.error('Failed to restore:', e); }
  await fetchTasks();
}

// Generic toast with one Undo button
function showActionToast(text, onUndo) {
  if (undoToastTimeout) clearTimeout(undoToastTimeout);
  const old = document.getElementById('undo-toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.id = 'undo-toast';
  el.className = 'undo-toast';
  el.innerHTML = `<span>${escapeHtml(text)}</span><button class="undo-btn">Undo</button>`;
  el.querySelector('.undo-btn').addEventListener('click', () => { el.remove(); onUndo(); });
  document.body.appendChild(el);
  undoToastTimeout = setTimeout(() => el.remove(), 6000);
}

// Last "won't do" reason from the notes, for the Won't do list
function wontDoReason(notes) {
  const lines = String(notes || '').split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  const m = last.match(/^\d{4}-\d{2}-\d{2} won't do(?: \([^)]*\))?: (.+)$/);
  return m ? m[1] : '';
}

// Initial load
trackAppOpen();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') trackAppOpen(); });
loadBriefCollapsedState();
fetchBrief();
fetchTasks();
