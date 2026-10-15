// Unit tests for the v1 repeat engine (src/v1.js). Run: node scripts/test-v1-repeat.mjs
import assert from 'assert/strict';
import { nextOnSchedule, nextAfterCompletion, advanceRepeat } from '../src/v1.js';
let n = 0; const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };
const S = (rule) => ({ mode: 'schedule', interval: 1, ...rule });
// daily / every 3 days
eq(nextOnSchedule(S({ freq: 'daily' }), '2026-10-11', '2026-10-01'), '2026-10-12');
eq(nextOnSchedule(S({ freq: 'daily', interval: 3 }), '2026-10-11', '2026-10-01'), '2026-10-13');
eq(nextOnSchedule(S({ freq: 'daily' }), '2026-09-01', '2026-10-01'), '2026-10-01', 'never before the anchor');
// weekly on the anchor day; Mon/Wed/Fri; every 2 weeks
eq(nextOnSchedule(S({ freq: 'weekly' }), '2026-10-11', '2026-10-04'), '2026-10-18', 'Sunday anchor');
eq(nextOnSchedule(S({ freq: 'weekly', byweekday: [1, 3, 5] }), '2026-10-12', '2026-10-01'), '2026-10-14');
eq(nextOnSchedule(S({ freq: 'weekly', byweekday: [1, 3, 5] }), '2026-10-16', '2026-10-01'), '2026-10-19');
eq(nextOnSchedule(S({ freq: 'weekly', interval: 2, byweekday: [2] }), '2026-10-06', '2026-10-06'), '2026-10-20', 'every other Tuesday');
eq(nextOnSchedule(S({ freq: 'weekly', interval: 2, byweekday: [2] }), '2026-10-13', '2026-10-06'), '2026-10-20');
// monthly: anchor day, the 31st clamps, last day, every 3 months
eq(nextOnSchedule(S({ freq: 'monthly' }), '2026-10-15', '2026-01-15'), '2026-11-15');
eq(nextOnSchedule(S({ freq: 'monthly' }), '2026-01-31', '2026-01-31'), '2026-02-28', '31st clamps in February');
eq(nextOnSchedule(S({ freq: 'monthly' }), '2026-02-28', '2026-01-31'), '2026-03-31', 'and comes back to the 31st');
eq(nextOnSchedule(S({ freq: 'monthly', bymonthday: -1 }), '2026-10-31', '2026-01-31'), '2026-11-30');
eq(nextOnSchedule(S({ freq: 'monthly', interval: 3 }), '2026-10-01', '2026-01-01'), '2027-01-01');
eq(nextOnSchedule(S({ freq: 'monthly', interval: 3 }), '2026-09-30', '2026-01-01'), '2026-10-01');
// yearly anchors on the first date (Feb 29 -> Feb 28)
eq(nextOnSchedule(S({ freq: 'yearly' }), '2026-10-11', '2020-03-14'), '2027-03-14');
eq(nextOnSchedule(S({ freq: 'yearly' }), '2027-03-13', '2020-03-14'), '2027-03-14');
eq(nextOnSchedule(S({ freq: 'yearly' }), '2026-01-01', '2024-02-29'), '2026-02-28');
// after completion
eq(nextAfterCompletion({ freq: 'weekly', interval: 2 }, '2026-10-11'), '2026-10-25');
eq(nextAfterCompletion({ freq: 'monthly', interval: 1 }, '2026-01-31'), '2026-02-28');
// advanceRepeat: early, late, end conditions, v0 recurrence
const T = (o) => ({ due_date: '2026-10-11', recurrence: 'daily', repeat_rule: null, ...o });
eq(advanceRepeat(T({}), '2026-10-11').next, '2026-10-12');
eq(advanceRepeat(T({ due_date: '2026-10-08' }), '2026-10-11').next, '2026-10-12', 'late: next after today, not after the old date');
eq(advanceRepeat(T({ due_date: '2026-10-15', recurrence: 'weekly' }), '2026-10-11').next, '2026-10-22', 'early: next after its date');
eq(advanceRepeat(T({ due_date: '2026-10-15', repeat_rule: JSON.stringify({ mode: 'after', freq: 'weekly', interval: 1 }) }), '2026-10-11').next, '2026-10-18', 'after completion counts from today');
eq(advanceRepeat(T({ repeat_rule: JSON.stringify({ mode: 'schedule', freq: 'daily', interval: 1, end: { after: 3 } }) }), '2026-10-11', 2).ended, true, 'third of three ends it');
eq(advanceRepeat(T({ repeat_rule: JSON.stringify({ mode: 'schedule', freq: 'daily', interval: 1, end: { after: 3 } }) }), '2026-10-11', 1).ended, false);
eq(advanceRepeat(T({ repeat_rule: JSON.stringify({ mode: 'schedule', freq: 'daily', interval: 1, end: { on: '2026-10-11' } }) }), '2026-10-11').ended, true, 'ends on a date');
eq(advanceRepeat(T({ due_date: '2026-03-14', recurrence: 'yearly', repeat_rule: JSON.stringify({ mode: 'schedule', freq: 'yearly', interval: 1, anchor: '2020-03-14' }) }), '2026-10-11').next, '2027-03-14');
eq(advanceRepeat(T({}), '2026-10-11').rule.anchor, '2026-10-11', 'anchor is set on first use');
console.log(`test-v1-repeat: ${n} checks passed`);
