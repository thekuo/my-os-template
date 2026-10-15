// Unit tests for the v1 client model (public/v1/model.js): dates, When parsing, events, brief markdown, sync diffs.
// Run: node scripts/test-v1-model.mjs
import assert from 'assert/strict';
import * as M from '../public/v1/model.js';

let n = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); n++; };

// dates
const sun = M.dnum('2026-10-11');
eq(M.diso(sun), '2026-10-11'); eq(M.dow(sun), 0); eq(M.dow(sun + 1), 1); eq(M.dow(M.dnum('1969-12-31')), 3);
eq(M.fmtD(sun, { weekday: 'long', month: 'short', day: 'numeric' }), 'Sunday, Oct 11');
eq(M.zoned('2026-10-12T06:30:00Z', 'America/Los_Angeles'), { day: sun, min: 23 * 60 + 30 }, 'UTC morning is the previous LA evening');
eq(M.fmtT(0), '12:00 AM'); eq(M.fmtT(13 * 60 + 5), '1:05 PM'); eq(M.fmtDur(95), '1h 35m');

// When field
const w = (s) => M.parseWhen(s, sun);
eq([w('today'), w('tonight'), w('someday'), w('clear'), w('tomorrow')], ['today', 'evening', 'someday', 'clear', 'd1']);
eq([w('in 3 days'), w('2w'), w('fri'), w('next fri'), w('sun'), w('next week')], ['d3', 'd14', 'd5', 'd12', 'd7', 'd1']);
eq([w('oct 20'), w('10/20'), w('oct 1'), w('1m')], ['d9', 'd9', 'd' + (M.dnum('2027-10-01') - sun), 'd31']);
eq([w('feb 30'), w('blah'), w('')], [null, null, null]);

// repeats (display)
const weekly = { date: sun, repeat: M.repeatFromRule({ freq: 'weekly' }, sun) };
eq(weekly.repeat.days, [0]); eq([M.occurs(weekly, sun + 7), M.occurs(weekly, sun + 8)], [true, false]);
const monthly = { date: sun, repeat: M.repeatFromRule({ freq: 'monthly' }, sun) };
eq([M.occurs(monthly, M.dnum('2026-11-11')), M.occurs(monthly, M.dnum('2026-11-12'))], [true, false]);
eq(M.repeatText(M.repeatFromRule({ freq: 'weekly', byweekday: [1, 3] }, sun)), 'weekly on Mon, Wed');

// events: all-day spans, timed events split at midnight, busy -> work
const ev = M.buildEvents([
  { id: 'a', cal: 'primary', all_day: true, start_date: '2026-10-11', end_date: '2026-10-13', title: 'Trip' },
  { id: 'b', cal: 'x', start: '2026-10-12T05:00:00Z', end: '2026-10-12T09:00:00Z', title: 'Late' }, // 10pm-2am LA
  { id: 'c', cal: 'w', busy: true, start: '2026-10-11T17:00:00Z', end: '2026-10-11T18:00:00Z', title: null },
], 'America/Los_Angeles');
eq(ev[sun].map(e => [e[0], e[1], e[2], e[3]]), [[null, null, 'Trip', 'personal'], [600, 660, 'Busy', 'work'], [1320, 1440, 'Late', 'family']]);
eq(ev[sun + 1].map(e => [e[0], e[1], e[2]]), [[null, null, 'Trip'], [0, 120, 'Late']]);
eq(ev[sun + 2], undefined, 'all-day end is exclusive');

// brief markdown
eq(M.parseBrief('# Monday\n\nHello **there**\nsecond line\n\n## Later\n- one\n- [two](http://x)\n<b>x</b>'),
  { title: 'Monday', blocks: [{ k: 'p', text: 'Hello there second line' }, { k: 'h', text: 'Later' }, { k: 'li', text: 'one' }, { k: 'li', text: 'two' }, { k: 'p', text: '<b>x</b>' }] });

// server row -> UI -> wire round trip is stable, and diffs are minimal
const srv = { id: 't-1', title: 'A', notes: null, start: 'date', start_date: '2026-10-12', due_date: '2026-10-12', evening: true, area_id: 'a-home', project_id: null, heading_id: null,
  deadline: '2026-10-20', flagged: true, checklist: [{ title: 'x', done: true }], tags: ['b', 'a'], today_index: 5, sort_index: null, repeat: null, status: 'open', list: 'Tasks' };
const t = M.fromServer(srv, 'America/Los_Angeles');
const base = M.wire(t);
eq(M.diffPatch(base, M.wire(t)), {});
t.date += 1; t.flag = false; t.tags = ['a', 'c']; t.checklist[0].d = false;
eq(M.diffPatch(base, M.wire(t)), { start: 'date', start_date: '2026-10-13', flagged: false, tags: ['a', 'c'], checklist: [{ title: 'x', done: false }] });
const t2 = M.fromServer(srv, 'America/Los_Angeles'); t2.start = 'someday'; delete t2.date;
eq(M.diffPatch(base, M.wire(t2)), { start: 'someday', evening: false }, 'undated clears evening');
const t3 = M.fromServer(srv, 'America/Los_Angeles'); t3.project = 'p-1'; t3.area = 'a-home';
eq(M.diffPatch(base, M.wire(t3)), { project_id: 'p-1', heading_id: null }, 'project wins over area');
const t4 = M.fromServer(srv, 'America/Los_Angeles'); t4.logged = true; t4.done = true;
eq(M.diffPatch(base, M.wire(t4)), { completed: true });
t4.canceled = true; eq(M.diffPatch(base, M.wire(t4)), { canceled: true });
const sug = M.fromServer({ ...srv, source: 'claude', suggestion_state: 'pending', reason: 'why' }, 'America/Los_Angeles');
eq(sug.sugg, 'why'); const sb = M.wire(sug);
delete sug.sugg; eq(M.diffPatch(sb, M.wire(sug)), { suggestion_state: 'accepted' });
sug.trashed = true; sug.dismissed = true; eq(M.diffPatch(sb, M.wire(sug)), { suggestion_state: 'dismissed' }, 'dismiss is not trash');
eq(M.createBody({ title: ' New ', start: 'date', date: sun, evening: true, project: 'p-1', heading: 'h-1', flag: true, tags: ['x'] }),
  { title: 'New', start: 'date', start_date: '2026-10-11', evening: true, project_id: 'p-1', heading_id: 'h-1', flagged: true, tags: ['x'] });
const done = M.fromServer({ ...srv, status: 'completed', completed_at: '2026-10-12T06:30:00Z' }, 'America/Los_Angeles');
eq([done.logged, done.stop], [true, sun], 'Logbook day is the local day');

// repeat rules: comparable keys, text, diffs
eq(M.ruleKey({ freq: 'weekly', byweekday: [3, 1], anchor: '2026-01-01' }), JSON.stringify({ mode: 'schedule', freq: 'weekly', interval: 1, byweekday: [1, 3] }), 'anchor ignored');
eq(M.ruleKey(null), null);
const R = (rule, d = sun) => M.repeatText(M.repeatFromRule(rule, d), rule);
eq([R({ freq: 'daily' }), R({ freq: 'weekly', byweekday: [1, 2, 3, 4, 5] }), R({ freq: 'weekly', interval: 2, byweekday: [0] }), R({ freq: 'monthly', bymonthday: 22 }), R({ freq: 'monthly', bymonthday: -1 })],
  ['daily', 'every weekday', 'every 2 weeks on Sun', 'monthly on the 22nd', 'monthly on the last day']);
eq([R({ mode: 'after', freq: 'weekly' }), R({ mode: 'after', freq: 'weekly', interval: 2 }), R({ freq: 'daily', end: { after: 10 } }), R({ freq: 'yearly', end: { on: '2027-03-01' } })],
  ['every week after completion', 'every 2 weeks after completion', 'daily, 10 times', 'yearly, until Mar 1, 2027']);
const rt = M.fromServer({ ...srv, repeat: { mode: 'schedule', freq: 'daily', interval: 1, anchor: '2026-01-01' } }, 'America/Los_Angeles');
const rb = M.wire(rt); eq(M.diffPatch(rb, M.wire(rt)), {});
rt.rule = { mode: 'after', freq: 'weekly', interval: 1 }; eq(M.diffPatch(rb, M.wire(rt)), { repeat: { mode: 'after', freq: 'weekly', interval: 1 } });
delete rt.rule; eq(M.diffPatch(rb, M.wire(rt)), { repeat: null });

console.log(`test-v1-model: ${n} checks passed`);
