// Plain-node tests for src/signals.js (B28/B29/B30 helpers). Run: node scripts/test-signals.mjs
import assert from 'assert/strict';
import {
  LATER_REASONS, DROP_REASONS, normalizeReason, cleanText, isLaterDate, shortDate,
  signalLine, appendNoteLine, endsWithWontDo, mergeProps, laDateOf,
} from '../src/signals.js';

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('normalizeReason codes, labels, empty, bad', () => {
  assert.deepEqual(normalizeReason('waiting', LATER_REASONS), { code: 'waiting' });
  assert.deepEqual(normalizeReason('Waiting on someone', LATER_REASONS), { code: 'waiting' });
  assert.deepEqual(normalizeReason('  not worth it ', DROP_REASONS), { code: 'not_worth_it' });
  assert.deepEqual(normalizeReason(undefined, DROP_REASONS), { code: null });
  assert.deepEqual(normalizeReason('', DROP_REASONS), { code: null });
  assert.ok(normalizeReason('nope', DROP_REASONS).error);
  assert.ok(normalizeReason(3, DROP_REASONS).error);
  assert.ok(normalizeReason('waiting', DROP_REASONS).error); // later reason is not a drop reason
  assert.ok(normalizeReason('toString', DROP_REASONS).error); // no prototype keys
});

t('cleanText one line, trimmed, capped', () => {
  assert.deepEqual(cleanText('  a\n b  ', 200), { text: 'a b' });
  assert.deepEqual(cleanText('   ', 200), { text: null });
  assert.deepEqual(cleanText(null, 200), { text: null });
  assert.ok(cleanText(5, 200).error);
  const long = cleanText('x'.repeat(300), 200).text;
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

t('isLaterDate', () => {
  assert.equal(isLaterDate('2026-10-07', '2026-10-09'), true);
  assert.equal(isLaterDate('2026-10-09', '2026-10-07'), false);
  assert.equal(isLaterDate('2026-10-07', '2026-10-07'), false);
  assert.equal(isLaterDate(null, '2026-10-07'), false);
  assert.equal(isLaterDate('2026-10-07', ''), false);
  assert.equal(isLaterDate('2026-12-31', '2027-01-01'), true);
});

t('shortDate', () => {
  assert.equal(shortDate('2026-10-09', '2026-10-07'), 'Oct 9');
  assert.equal(shortDate('2027-01-04', '2026-10-07'), 'Jan 4, 2027');
});

t('signalLine formats', () => {
  const today = '2026-10-07';
  assert.equal(signalLine('snoozed', { today, to: '2026-10-09', label: 'Waiting on someone', text: 'no reply yet' }),
    '2026-10-07 snoozed → Oct 9: Waiting on someone (no reply yet)');
  assert.equal(signalLine('moved', { today, to: '2026-10-12', label: 'No time' }), '2026-10-07 moved → Oct 12: No time');
  assert.equal(signalLine('snoozed', { today, to: '2026-10-08', text: 'rain' }), '2026-10-07 snoozed → Oct 8: rain');
  assert.equal(signalLine('done', { today, text: 'Covered; needs the right billing code.' }), '2026-10-07 done: Covered; needs the right billing code.');
  assert.equal(signalLine('wont_do', { today, label: 'Not worth it' }), "2026-10-07 won't do: Not worth it");
  assert.equal(signalLine('wont_do', { today, label: 'Duplicate', detail: 'skipped Oct 7' }), "2026-10-07 won't do (skipped Oct 7): Duplicate");
  assert.equal(signalLine('wont_do', { today, text: 'meh', detail: 'stopped series' }), "2026-10-07 won't do (stopped series): meh");
  assert.equal(signalLine('restored', { today }), '2026-10-07 restored');
  assert.throws(() => signalLine('bogus', { today }));
});

t('appendNoteLine never overwrites, newest last', () => {
  assert.equal(appendNoteLine(null, 'L1'), 'L1');
  assert.equal(appendNoteLine('', 'L1'), 'L1');
  assert.equal(appendNoteLine('old note\n\n', 'L1'), 'old note\nL1');
  assert.equal(appendNoteLine('a\nb', 'c'), 'a\nb\nc');
  const twice = appendNoteLine(appendNoteLine('x', 'one'), 'two');
  assert.equal(twice, 'x\none\ntwo');
});

t('endsWithWontDo', () => {
  assert.equal(endsWithWontDo("note\n2026-10-07 won't do: Not worth it\n"), true);
  assert.equal(endsWithWontDo("2026-10-07 won't do (skipped Oct 7): Duplicate"), true);
  assert.equal(endsWithWontDo("2026-10-07 won't do: x\n2026-10-07 restored"), false);
  assert.equal(endsWithWontDo('I won\'t do this'), false);
  assert.equal(endsWithWontDo(null), false);
});

t('mergeProps', () => {
  assert.deepEqual(JSON.parse(mergeProps('{"from":"a","to":"b"}', { reason: 'waiting', text: null })), { from: 'a', to: 'b', reason: 'waiting' });
  assert.deepEqual(JSON.parse(mergeProps(null, { outcome: 'ok' })), { outcome: 'ok' });
  assert.deepEqual(JSON.parse(mergeProps('not json', { reason: 'x' })), { reason: 'x' });
  assert.deepEqual(JSON.parse(mergeProps('[1]', { reason: 'x' })), { reason: 'x' });
});

t('laDateOf', () => {
  assert.equal(laDateOf('2026-10-07T06:59:00Z'), '2026-10-06'); // 11:59pm PDT
  assert.equal(laDateOf('2026-10-07T07:01:00Z'), '2026-10-07');
  assert.equal(laDateOf('2026-10-07 12:00:00'), '2026-10-07');
  assert.equal(laDateOf('garbage'), null);
});

console.log(`test-signals: ${n} groups passed`);
