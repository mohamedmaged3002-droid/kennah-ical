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

// ---- regression tests for the fail-OPEN holes found in preflight review ----

const NOW = Date.parse('2026-08-10T13:00:00Z');
const healthy = {
  ok: true, nights: N, blocked: 11, available: 355,
  syncStatus: 'success', lastSyncedAt: '2026-08-10T12:00:00Z',
  firstDate: '2026-08-10', now: NOW,
};

test('refuses a FROZEN upstream sync even though it reports success', () => {
  // wp 92006 shipped syncStatus "success", full 366-night coverage, zero errors —
  // and a calendar anchored 39 days in the past. Every pre-existing gate passed it,
  // and the .ics it produced advertised all 366 future nights as open.
  const v = shouldWrite(null, { ...healthy, lastSyncedAt: '2026-07-02T21:09:04.561Z' }, N);
  assert.equal(v.write, false);
  assert.equal(v.reason, 'upstream-sync-stale');
});

test('refuses a calendar whose first night is in the past', () => {
  const v = shouldWrite(null, { ...healthy, firstDate: '2026-07-02' }, N);
  assert.equal(v.write, false);
  assert.equal(v.reason, 'calendar-anchored-in-past');
});

test('refuses a unit Kennah has flagged maintenanceMode', () => {
  const v = shouldWrite(null, { ...healthy, maintenanceMode: true }, N);
  assert.equal(v.write, false);
  assert.equal(v.reason, 'maintenance-mode');
});

test('refuses a non-success syncStatus', () => {
  assert.equal(shouldWrite(null, { ...healthy, syncStatus: 'failed' }, N).write, false);
});

test('block loss is refused until enough runs agree, then accepted', () => {
  // The dangerous direction: blocked nights VANISHING re-opens sold dates.
  // available = nights - blocked by construction, so the coverage gates are blind
  // to this and only an explicit block-loss gate catches it.
  const prev = { blocked: 230, availableCount: 136, collapseStreak: 0 };
  const cur = { ...healthy, blocked: 0, available: N };
  let streak = 0;
  for (let i = 1; i < COLLAPSE_CONFIRM_RUNS; i++) {
    const v = shouldWrite({ ...prev, collapseStreak: streak }, cur, N);
    assert.equal(v.write, false, `run ${i} should refuse`);
    assert.equal(v.reason, 'block-loss');
    streak = v.collapseStreak;
  }
  const final = shouldWrite({ ...prev, collapseStreak: streak }, cur, N);
  assert.equal(final.write, true);
  assert.equal(final.reason, 'block-loss-confirmed');
});

test('a healthy run with fresh upstream data still writes', () => {
  assert.equal(shouldWrite({ blocked: 11, availableCount: 355, collapseStreak: 0 }, healthy, N).write, true);
});

test('a refused unit whose .ics was deleted must not keep a live updatedAt', () => {
  // 92006 regression: its bad feed was deleted, but the carried-forward index
  // entry kept updatedAt from before the deletion, so check-stale.js alarmed
  // hourly on a feed that did not exist. A held unit reports as held, not stale.
  const prev = { wp: 92006, updatedAt: '2026-08-10T13:38:03.890Z', blocked: 7, availableCount: 359 };
  const stillServed = false;
  const carried = { ...prev, collapseStreak: 0, ...(stillServed ? {} : { updatedAt: null, neverWritten: true }) };
  assert.equal(carried.updatedAt, null);
  assert.equal(carried.neverWritten, true);
  assert.equal(carried.blocked, 7, 'counters must survive so the block-loss gate keeps its baseline');
});

// ---- price watch ----
const { toRanges: priceRanges, diffPrices, buildMessage } = require('../src/pricediff');

const unit = (price, from = '2026-09-01', to = '2026-09-10') =>
  ({ name: 'T', ranges: [{ from, to, price }] });

test('a quiet day produces no message, so no email', () => {
  assert.equal(buildMessage(diffPrices({ 92001: unit(100) }, { 92001: unit(100) })), null);
});

test('a real reprice is detected with direction and night count', () => {
  const d = diffPrices({ 92001: unit(100) }, { 92001: unit(120) });
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].count, 10);
  assert.equal(d.changed[0].direction, 'increase');
});

test('the rolling 366-day window growing is NOT a price change', () => {
  // Kennah's calendar gains a night at the tail every day. Counting that would
  // email a change daily forever and the digest would become noise.
  const base = { 92001: unit(100, '2026-09-01', '2026-09-05') };
  const cur = { 92001: unit(100, '2026-09-01', '2026-09-09') };
  assert.equal(buildMessage(diffPrices(base, cur)), null);
});

test('roster drift is reported in both directions', () => {
  const d = diffPrices({ 92001: unit(100) }, { 92002: unit(100) });
  assert.deepEqual(d.added, [92002]);
  assert.deepEqual(d.removed, [92001]);
  assert.match(buildMessage(d).emailSubject, /new/);
});

test('price ranges round-trip contiguous nights into one run', () => {
  const rows = [
    { date: '2026-09-01', price: 100 }, { date: '2026-09-02', price: 100 },
    { date: '2026-09-03', price: 120 },
  ];
  assert.deepEqual(priceRanges(rows), [
    { from: '2026-09-01', to: '2026-09-02', price: 100 },
    { from: '2026-09-03', to: '2026-09-03', price: 120 },
  ]);
});

test('a brand-new listing on kennahstays.com is news even with no price movement', () => {
  // sync.js already saw this hourly but wrote it only to report.json, which
  // nothing reads — the L-064 shape. It must reach a human.
  const quiet = { changed: [], added: [], removed: [], totalNights: 0 };
  const m = buildMessage({ ...quiet, newOnSite: [{ slug: 'x', name: 'X' }], goneFromSite: [] });
  assert.ok(m, 'a new listing must produce a message');
  assert.match(m.emailSubject, /NEW listing/);
  assert.match(m.emailBody, /needs a wp_post_id/);
});

test('a listing vanishing from kennahstays.com is news even with no price movement', () => {
  const quiet = { changed: [], added: [], removed: [], totalNights: 0 };
  const m = buildMessage({ ...quiet, newOnSite: [], goneFromSite: [{ wp: 92001, slug: 'x', name: 'X' }] });
  assert.ok(m);
  assert.match(m.emailSubject, /GONE/);
});

test('a genuinely quiet day still sends nothing', () => {
  assert.equal(buildMessage({ changed: [], added: [], removed: [], totalNights: 0,
                              newOnSite: [], goneFromSite: [] }), null);
});
