// Parse quick-add input
// Returns { title, due_date, recurrence, priority, list, explicit, backlog }
function parseQuickAdd(text, today) {
  const rawTokens = text.trim().split(/\s+/);
  const tokens = rawTokens.map(t => t.toLowerCase());
  let title = [];
  let dueDate = today;
  let recurrence = null;
  let priority = null;
  let list = 'Tasks';
  const explicit = { due_date: false, priority: false, recurrence: false };
  let backlog = false; // B43: "someday" / "backlog" -> no due date

  const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const weekdaysFull = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const months = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Check for special keywords
    if (token === 'today') {
      dueDate = today;
      explicit.due_date = true;
      continue;
    }

    if (token === 'tomorrow' || token === 'tmr') {
      const d = new Date(today + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 1);
      dueDate = d.toISOString().slice(0, 10);
      explicit.due_date = true;
      continue;
    }

    // Check for next week - Monday of next week
    if (token === 'next' && i + 1 < tokens.length && tokens[i + 1] === 'week') {
      const d = new Date(today + 'T00:00:00Z');
      const dow = d.getUTCDay();
      let daysUntilNextMonday = 8 - dow;
      if (dow === 1) daysUntilNextMonday = 7;
      d.setUTCDate(d.getUTCDate() + daysUntilNextMonday);
      dueDate = d.toISOString().slice(0, 10);
      explicit.due_date = true;
      i++; // skip 'week'
      continue;
    }

    // Check for weekday - next occurrence of that weekday (skip today if today is that day)
    const shortIdx = weekdays.indexOf(token);
    const longIdx = token.length > 3 ? weekdaysFull.indexOf(token) : -1;
    if (shortIdx !== -1 || longIdx !== -1) {
      const idx = shortIdx !== -1 ? shortIdx : longIdx;
      const dayNum = (idx + 1) % 7;
      const d = new Date(today + 'T00:00:00Z');
      const dow = d.getUTCDay();
      let daysAhead = dayNum - dow;
      if (daysAhead <= 0) daysAhead += 7;
      d.setUTCDate(d.getUTCDate() + daysAhead);
      dueDate = d.toISOString().slice(0, 10);
      explicit.due_date = true;
      continue;
    }

    // Check for date format: oct 12, 10/12, 2026-10-12
    if (Object.keys(months).includes(token) && i + 1 < tokens.length) {
      const monthNum = months[token];
      const day = parseInt(tokens[i + 1], 10);
      if (!isNaN(day) && day >= 1 && day <= 31) {
        let year = parseInt(today.slice(0, 4), 10);
        const todayMonth = parseInt(today.slice(5, 7), 10);
        const todayDay = parseInt(today.slice(8, 10), 10);
        if (monthNum < todayMonth || (monthNum === todayMonth && day < todayDay)) {
          year++;
        }
        dueDate = `${year}-${String(monthNum).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        explicit.due_date = true;
        i++; // skip day
        continue;
      }
    }

    // Check for slash date: 10/12
    if (token.includes('/')) {
      const parts = token.split('/');
      if (parts.length === 2) {
        const month = parseInt(parts[0], 10);
        const day = parseInt(parts[1], 10);
        if (!isNaN(month) && !isNaN(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
          let year = parseInt(today.slice(0, 4), 10);
          const todayMonth = parseInt(today.slice(5, 7), 10);
          const todayDay = parseInt(today.slice(8, 10), 10);
          if (month < todayMonth || (month === todayMonth && day < todayDay)) {
            year++;
          }
          dueDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          explicit.due_date = true;
          continue;
        }
      }
    }

    // Check for ISO date: 2026-10-12
    if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
      dueDate = token;
      explicit.due_date = true;
      continue;
    }

    // Check for recurrence
    if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(token)) {
      recurrence = token;
      explicit.recurrence = true;
      continue;
    }

    // B43: backlog keywords
    if (token === 'someday' || token === 'backlog') {
      backlog = true;
      continue;
    }

    // Check for priority
    if (token === 'p0' || token === 'p1' || token === 'p2' || token === 'p3') {
      priority = token.toUpperCase();
      explicit.priority = true;
      continue;
    }

    // Check for list marker
    if (token === '#bday' || token === '#birthday') {
      list = 'Birthdays';
      if (!recurrence) recurrence = 'yearly';
      continue;
    }

    // Add to title
    title.push(rawTokens[i]);
  }

  // An explicit date or a repeat wins over the backlog keyword
  if (backlog && (explicit.due_date || recurrence)) backlog = false;
  return {
    title: title.join(' '),
    due_date: backlog ? null : dueDate,
    backlog,
    recurrence,
    priority,
    list,
    explicit,
  };
}

if (typeof globalThis !== 'undefined') {
  globalThis.parseQuickAdd = parseQuickAdd;
}
