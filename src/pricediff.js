// Kennah price-change detection.
//
// Why a stored baseline and not "diff against the live DB" (the brassbell model):
// sync.js already refreshes unit_daily_prices EVERY HOUR, so by the time a daily
// watch ran, the DB would already contain today's prices and every diff would be
// empty. The baseline therefore lives in the repo and is advanced by this job.
//
// It is stored as date RANGES, not one row per night: 55 units x 366 nights is
// 20k rows, but the same data as contiguous same-price runs is ~210 entries — a
// git-friendly file whose diff is itself readable.

// Collapse [{date, price}] into [{from, to, price}] runs.
function toRanges(rows) {
  const out = [];
  for (const { date, price } of [...rows].sort((a, b) => a.date < b.date ? -1 : 1)) {
    const last = out[out.length - 1];
    const next = new Date(`${last?.to}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    if (last && last.price === price && next.toISOString().slice(0, 10) === date) last.to = date;
    else out.push({ from: date, to: date, price });
  }
  return out;
}

const expand = (ranges) => {
  const m = new Map();
  for (const r of ranges || []) {
    for (let d = new Date(`${r.from}T00:00:00Z`); d <= new Date(`${r.to}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
      m.set(d.toISOString().slice(0, 10), r.price);
    }
  }
  return m;
};

/**
 * @param baseline {wp: {name, ranges}}   previous snapshot
 * @param current  {wp: {name, ranges}}   today's fetch
 * @returns { changed:[], added:[], removed:[], totalNights }
 */
function diffPrices(baseline, current) {
  const changed = [];
  for (const [wp, cur] of Object.entries(current)) {
    const base = baseline[wp];
    if (!base) continue;                     // new unit — reported separately
    const b = expand(base.ranges), c = expand(cur.ranges);
    const nights = [];
    for (const [date, price] of c) {
      // Compare only dates present in BOTH. Kennah serves a ROLLING 366-day
      // window, so every run gains ~1 new night at the tail and loses one at the
      // head. Counting those as changes would email a "price change" every single
      // day forever, which is how a watch becomes noise people filter out.
      if (!b.has(date)) continue;
      if (b.get(date) !== price) nights.push({ date, from: b.get(date), to: price });
    }
    if (nights.length) {
      const ups = nights.filter((n) => n.to > n.from).length;
      changed.push({
        wp: Number(wp), name: cur.name, nights,
        count: nights.length,
        direction: ups === nights.length ? 'increase' : ups === 0 ? 'decrease' : 'mixed',
        minFrom: Math.min(...nights.map((n) => n.from)),
        maxTo: Math.max(...nights.map((n) => n.to)),
      });
    }
  }
  const added = Object.keys(current).filter((wp) => !baseline[wp]).map(Number);
  const removed = Object.keys(baseline).filter((wp) => !current[wp]).map(Number);
  changed.sort((a, b) => b.count - a.count);
  return { changed, added, removed, totalNights: changed.reduce((s, c) => s + c.count, 0) };
}

// null => nothing happened => send-alert.js sends NOTHING. The gate is here so
// "no news" can never become a daily email.
function buildMessage(diff, meta = {}) {
  const { changed, added, removed, totalNights, newOnSite = [], goneFromSite = [] } = diff;
  // A new or vanished LISTING is news even on a day when no price moved.
  if (!changed.length && !added.length && !removed.length
      && !newOnSite.length && !goneFromSite.length) return null;

  const bits = [];
  if (changed.length) bits.push(`${changed.length} unit${changed.length > 1 ? 's' : ''} repriced`);
  if (added.length) bits.push(`${added.length} new`);
  if (removed.length) bits.push(`${removed.length} unpriced`);
  if (newOnSite.length) bits.push(`${newOnSite.length} NEW listing${newOnSite.length > 1 ? 's' : ''}`);
  if (goneFromSite.length) bits.push(`${goneFromSite.length} listing${goneFromSite.length > 1 ? 's' : ''} GONE`);
  const emailSubject = `Kennah: ${bits.join(', ')}`;

  const lines = [`${emailSubject} (${totalNights} night${totalNights === 1 ? '' : 's'} affected).`, ''];
  for (const c of changed.slice(0, 25)) {
    const arrow = c.direction === 'increase' ? 'up' : c.direction === 'decrease' ? 'down' : 'mixed';
    lines.push(`  ${c.wp}  ${c.name}`);
    lines.push(`      ${c.count} night(s) ${arrow}: $${c.minFrom} -> $${c.maxTo}`);
  }
  if (changed.length > 25) lines.push(`  ... and ${changed.length - 25} more (see attached sheet)`);
  if (newOnSite.length) {
    lines.push('', 'NEW on kennahstays.com — not onboarded, needs a wp_post_id:');
    for (const n of newOnSite) lines.push(`  ${n.name || n.slug}  (${n.slug})`);
  }
  if (goneFromSite.length) {
    lines.push('', 'GONE from kennahstays.com — check for delist before the feed goes stale:');
    for (const g of goneFromSite) lines.push(`  ${g.wp}  ${g.name || g.slug}`);
  }
  if (added.length) lines.push('', `Now priced (were not before): ${added.join(', ')}`);
  if (removed.length) lines.push('', `Lost prices (check calendar): ${removed.join(', ')}`);
  lines.push('', 'Prices are Kennah\'s OTA rate in USD. Automated (kennah-ical).');
  if (meta.note) lines.push('', meta.note);

  return { emailSubject, emailBody: lines.join('\n') };
}

module.exports = { toRanges, expand, diffPrices, buildMessage };
