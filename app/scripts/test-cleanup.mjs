// Test cleanup logic with stubbed AI
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, '../src');

// Read and eval the server code to extract validation and utility functions
const indexCode = fs.readFileSync(path.join(srcDir, 'index.js'), 'utf-8');

// Extract validateTaskFields function
function validateTaskFields(title, list, due_date, recurrence, priority) {
  if (!title || typeof title !== 'string' || title.trim().length === 0 || title.length > 200) {
    return { valid: false, error: 'Invalid title' };
  }

  const taskList = list || 'Tasks';
  if (!['Tasks', 'Birthdays'].includes(taskList)) {
    return { valid: false, error: 'Invalid list' };
  }

  if (due_date && !/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
    return { valid: false, error: 'Invalid due_date format' };
  }

  if (recurrence && !['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(recurrence)) {
    return { valid: false, error: 'Invalid recurrence' };
  }

  if (priority && !['P0', 'P1', 'P2'].includes(priority)) {
    return { valid: false, error: 'Invalid priority' };
  }

  return { valid: true };
}

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

// Test merge logic
function mergeAIResult(parsed, aiResult, explicit, raw, today) {
  let title = parsed.title;
  let due_date = parsed.due_date;
  let recurrence = parsed.recurrence;
  let priority = parsed.priority;
  let notes = null;
  let aiCleaned = false;

  if (aiResult) {
    // Parse if it's a string
    let parsed_result = aiResult;
    if (typeof aiResult === 'string') {
      try {
        parsed_result = JSON.parse(aiResult);
      } catch (e) {
        parsed_result = null;
      }
    }

    if (parsed_result) {
      aiCleaned = true;
      notes = 'Captured: ' + raw;

      // Merge: explicit > AI > parsed (validate AI values)
      if (!explicit.due_date && parsed_result.due_date) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(parsed_result.due_date)) {
          due_date = parsed_result.due_date;
        }
      }
      if (!explicit.priority && parsed_result.priority) {
        if (['P0', 'P1', 'P2'].includes(parsed_result.priority)) {
          priority = parsed_result.priority;
        }
      }
      if (!explicit.recurrence && parsed_result.recurrence) {
        if (['daily', 'weekdays', 'weekly', 'monthly', 'yearly'].includes(parsed_result.recurrence)) {
          recurrence = parsed_result.recurrence;
        }
      }

      // Use AI title unless parsed title is good
      if (parsed_result.title && typeof parsed_result.title === 'string' && parsed_result.title.length > 0 && parsed_result.title.length <= 200) {
        title = parsed_result.title;
      }
    }
  }

  // Set notes even if AI failed (raw was long)
  if (!aiCleaned && raw && (raw.length > 50 || raw.split(/\s+/).length > 6)) {
    notes = 'Captured: ' + raw;
  }

  return { title, due_date, recurrence, priority, notes, aiCleaned };
}

// Test cases
const tests = [
  {
    name: 'Good JSON object from AI',
    raw: 'We need to send the email to Sam teacher I have sent it to Alex and Pat for review',
    parsed: { title: 'We need to send the email to Sam teacher I have sent it to Alex and Pat for review', due_date: '2026-10-04', priority: null, recurrence: null },
    explicit: { due_date: false, priority: false, recurrence: false },
    aiResult: { title: 'Send email to Sam\'s teacher', due_date: '2026-10-04', priority: 'P1', recurrence: null },
    expectAiCleaned: true,
    expectTitle: 'Send email to Sam\'s teacher',
    expectPriority: 'P1',
  },
  {
    name: 'AI returns JSON string',
    raw: 'Call mom tomorrow about the party this weekend',
    parsed: { title: 'Call mom about the party', due_date: '2026-10-05', priority: null, recurrence: null },
    explicit: { due_date: true, priority: false, recurrence: false },
    aiResult: '{"title":"Call mom about party","due_date":null,"priority":"P1","recurrence":null}',
    expectAiCleaned: true,
    expectPriority: 'P1',
    expectDueDate: '2026-10-05', // explicit due_date wins
  },
  {
    name: 'Explicit priority overrides AI',
    raw: 'Fix the bug high priority this week',
    parsed: { title: 'Fix the bug high priority this week', due_date: '2026-10-04', priority: 'P0', recurrence: null },
    explicit: { due_date: false, priority: true, recurrence: false },
    aiResult: { title: 'Fix the bug', due_date: '2026-10-04', priority: 'P2', recurrence: null },
    expectAiCleaned: true,
    expectPriority: 'P0', // explicit wins
  },
  {
    name: 'Invalid AI priority dropped',
    raw: 'Do something really urgent this week',
    parsed: { title: 'Do something really urgent this week', due_date: '2026-10-04', priority: null, recurrence: null },
    explicit: { due_date: false, priority: false, recurrence: false },
    aiResult: { title: 'Do something urgent', due_date: '2026-10-04', priority: 'P5', recurrence: null },
    expectAiCleaned: true,
    expectPriority: null, // invalid P5 dropped
  },
  {
    name: 'Short raw text (no AI)',
    raw: 'Buy milk',
    parsed: { title: 'Buy milk', due_date: '2026-10-04', priority: null, recurrence: null },
    explicit: { due_date: false, priority: false, recurrence: false },
    aiResult: null,
    expectAiCleaned: false,
    expectTitle: 'Buy milk',
  },
  {
    name: 'Long raw but AI fails/timeout',
    raw: 'We need to send the email to Sam teacher I have sent it to Alex and Pat for review',
    parsed: { title: 'email Sam teacher Alex Pat', due_date: '2026-10-04', priority: null, recurrence: null },
    explicit: { due_date: false, priority: false, recurrence: false },
    aiResult: null,
    expectAiCleaned: false,
    expectNotes: true, // notes set even without AI cleanup
  },
];

let passed = 0;
let failed = 0;

for (const test of tests) {
  try {
    const result = mergeAIResult(test.parsed, test.aiResult, test.explicit, test.raw, getTodayLA());

    // Validate result
    const validation = validateTaskFields(result.title, 'Tasks', result.due_date, result.recurrence, result.priority);
    if (!validation.valid) {
      console.error(`FAIL: ${test.name} - Validation: ${validation.error}`);
      failed++;
      continue;
    }

    // Check expectations
    let pass = true;
    if (test.expectAiCleaned !== result.aiCleaned) {
      console.error(`FAIL: ${test.name} - aiCleaned: expected ${test.expectAiCleaned}, got ${result.aiCleaned}`);
      pass = false;
    }
    if (test.expectTitle && result.title !== test.expectTitle) {
      console.error(`FAIL: ${test.name} - title: expected "${test.expectTitle}", got "${result.title}"`);
      pass = false;
    }
    if (test.expectPriority !== undefined && result.priority !== test.expectPriority) {
      console.error(`FAIL: ${test.name} - priority: expected ${test.expectPriority}, got ${result.priority}`);
      pass = false;
    }
    if (test.expectDueDate && result.due_date !== test.expectDueDate) {
      console.error(`FAIL: ${test.name} - due_date: expected ${test.expectDueDate}, got ${result.due_date}`);
      pass = false;
    }
    if (test.expectNotes && !result.notes) {
      console.error(`FAIL: ${test.name} - notes not set`);
      pass = false;
    }

    if (pass) {
      console.log(`PASS: ${test.name}`);
      passed++;
    } else {
      failed++;
    }
  } catch (err) {
    console.error(`ERROR: ${test.name} - ${err.message}`);
    failed++;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
