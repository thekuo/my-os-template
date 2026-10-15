import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load parse.js
const parseJs = fs.readFileSync(path.join(__dirname, '../public/parse.js'), 'utf-8');
eval(parseJs);

const today = '2026-10-04'; // Sunday

const testCases = [
  {
    input: 'buy groceries tomorrow',
    expected: { title: 'buy groceries', due_date: '2026-10-05', recurrence: null, priority: null, list: 'Tasks' }
  },
  {
    input: 'plan trip next week weekly',
    expected: { title: 'plan trip', due_date: '2026-10-12', recurrence: 'weekly', priority: null, list: 'Tasks' }
  },
  {
    input: 'meeting mon p0',
    expected: { title: 'meeting', due_date: '2026-10-05', recurrence: null, priority: 'P0', list: 'Tasks' }
  },
  {
    input: 'birthday party oct 15 #bday yearly',
    expected: { title: 'birthday party', due_date: '2026-10-15', recurrence: 'yearly', priority: null, list: 'Birthdays' }
  },
  {
    input: 'call mom 10/25 weekly',
    expected: { title: 'call mom', due_date: '2026-10-25', recurrence: 'weekly', priority: null, list: 'Tasks' }
  },
  {
    input: 'exercise daily p1',
    expected: { title: 'exercise', due_date: '2026-10-04', recurrence: 'daily', priority: 'P1', list: 'Tasks' }
  },
  {
    input: 'dentist appointment 2026-10-20 p2',
    expected: { title: 'dentist appointment', due_date: '2026-10-20', recurrence: null, priority: 'P2', list: 'Tasks' }
  },
  {
    input: 'tidy garage p3',
    expected: { title: 'tidy garage', due_date: '2026-10-04', recurrence: null, priority: 'P3', list: 'Tasks' }
  },
  {
    input: 'learn piano someday',
    expected: { title: 'learn piano', due_date: null, recurrence: null, priority: null, list: 'Tasks' }
  },
  {
    input: 'backlog fix the fence p3',
    expected: { title: 'fix the fence', due_date: null, recurrence: null, priority: 'P3', list: 'Tasks' }
  },
  {
    input: 'someday call bank tmr',
    expected: { title: 'call bank', due_date: '2026-10-05', recurrence: null, priority: null, list: 'Tasks' }
  },
  {
    input: 'review code tmr',
    expected: { title: 'review code', due_date: '2026-10-05', recurrence: null, priority: null, list: 'Tasks' }
  },
  {
    input: 'team meeting wed p0 weekly',
    expected: { title: 'team meeting', due_date: '2026-10-07', recurrence: 'weekly', priority: 'P0', list: 'Tasks' }
  },
  {
    input: 'project deadline today p0',
    expected: { title: 'project deadline', due_date: '2026-10-04', recurrence: null, priority: 'P0', list: 'Tasks' }
  },
  {
    input: 'dad birthday #birthday',
    expected: { title: 'dad birthday', due_date: '2026-10-04', recurrence: 'yearly', priority: null, list: 'Birthdays' }
  },
  {
    input: 'work tasks weekdays p1',
    expected: { title: 'work tasks', due_date: '2026-10-04', recurrence: 'weekdays', priority: 'P1', list: 'Tasks' }
  },
];

let passed = 0;
let failed = 0;

for (let i = 0; i < testCases.length; i++) {
  const test = testCases[i];
  const result = parseQuickAdd(test.input, today);

  // Compare core fields (ignore explicit which is new)
  const resultCore = {
    title: result.title,
    due_date: result.due_date,
    recurrence: result.recurrence,
    priority: result.priority,
    list: result.list
  };
  const match = JSON.stringify(resultCore) === JSON.stringify(test.expected);

  if (match) {
    passed++;
    console.log(`✓ Test ${i + 1}: "${test.input}"`);
  } else {
    failed++;
    console.log(`✗ Test ${i + 1}: "${test.input}"`);
    console.log(`  Expected: ${JSON.stringify(test.expected)}`);
    console.log(`  Got:      ${JSON.stringify(resultCore)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed out of ${testCases.length} tests`);
process.exit(failed > 0 ? 1 : 0);
