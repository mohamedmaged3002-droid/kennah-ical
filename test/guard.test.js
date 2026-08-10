const test = require('node:test');
const assert = require('node:assert');
const { shouldWrite, COLLAPSE_CONFIRM_RUNS } = require('../src/guard');
const { toRanges } = require('../src/dates');
const { buildIcal } = require('../src/ical');

const N = 366;

test('refuses a unit with no availability data (the 6 Maadi serviced apartments)', () => {
  // The whole point: [] means "we know nothing", not "all 366 nights are free".
  const v = shouldWrite(null, { ok: true, nights: 0, blocked: 0, available: 0 }, N);
  assert.equal(v.write, false);
  assert.equal(v.reason, 'no-availability-data');
});

test('refuses a failed fetch', () => {
  assert.equal(shouldWrite(null, { ok: false, nights: 0, blocked: 0, available: 0 }, N).write, false);
});

test('refuses a truncated calendar', () => {
  const v = shouldWrite(null, { ok: true, nights: 200, blocked: 5, available: 195 }, N);
  assert.equal(v.write, false);
  assert.equal(v.reason, 'low-coverage');
});

test('writes a healthy calendar', () => {
  assert.equal(shouldWrite(null, { ok: true, nights: N, blocked: 11, available: 355 }, N).write, true);
});

test('availability collapse is refused until enough runs agree, then accepted', () => {
  const prev = { availableCount: 355, collapseStreak: 0 };
  const cur = { ok: true, nights: N, blocked: 360, available: 6 };
  let streak = 0;
  for (let i = 1; i < COLLAPSE_CONFIRM_RUNS; i++) {
    const v = shouldWrite({ ...prev, collapseStreak: streak }, cur, N);
    assert.equal(v.write, false, `run ${i} should refuse`);
    streak = v.collapseStreak;
  }
  const final = shouldWrite({ ...prev, collapseStreak: streak }, cur, N);
  assert.equal(final.write, true);
  assert.equal(final.reason, 'availability-collapse-confirmed');
});

test('an unhealthy run resets the collapse streak', () => {
  const v = shouldWrite({ availableCount: 355, collapseStreak: 2 }, { ok: false, nights: 0, blocked: 0, available: 0 }, N);
  assert.equal(v.collapseStreak, 0);
});

test('consecutive blocked nights merge into one half-open range', () => {
  assert.deepEqual(toRanges(['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-20']), [
    { start: '2026-08-10', endExclusive: '2026-08-13' },
    { start: '2026-08-20', endExclusive: '2026-08-21' },
  ]);
});

test('a single blocked night spans exactly one day', () => {
  assert.deepEqual(toRanges(['2026-08-10']), [{ start: '2026-08-10', endExclusive: '2026-08-11' }]);
});

test('UID encodes the range so a changed block yields a new UID', () => {
  const a = buildIcal({ wp: 92001, title: 'T', ranges: toRanges(['2026-08-10']) });
  const b = buildIcal({ wp: 92001, title: 'T', ranges: toRanges(['2026-08-10', '2026-08-11']) });
  const uid = (s) => s.match(/UID:(.+)/)[1].trim();
  assert.notEqual(uid(a), uid(b));
});

test('emitted calendar carries DTSTAMP and is CRLF terminated', () => {
  const ics = buildIcal({ wp: 92001, title: 'T', ranges: toRanges(['2026-08-10']) });
  assert.match(ics, /DTSTAMP:\d{8}T\d{6}Z/);
  assert.ok(ics.endsWith('\r\n'));
});
