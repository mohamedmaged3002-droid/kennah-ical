#!/usr/bin/env node
// Daily Kennah price watch: fetch -> diff vs the committed baseline -> emit
// artifacts -> advance the baseline. Writes NOTHING to Supabase; sync.js already
// owns unit_daily_prices and runs hourly. This job only reports.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { listApartments, getApartment, mapLimit } = require('./src/api');
const { toRanges, diffPrices, buildMessage } = require('./src/pricediff');

const UNITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'units.json'), 'utf8'));
const BASELINE = path.join(__dirname, 'data', 'price-baseline.json');
const OUT = path.join(__dirname, 'out');

async function main() {
  const dry = process.argv.includes('--dry-run');
  fs.mkdirSync(OUT, { recursive: true });

  // Roster drift, against Kennah's LIVE list rather than our mapping. sync.js
  // already computes this hourly but only writes it to docs/report.json, which
  // nothing reads — the same shape as the Mynt delisting that went unnoticed for
  // 18 days (L-064). A unit appearing or vanishing is exactly the kind of thing
  // that should reach a human, so it rides along in the daily digest.
  let roster = [];
  try { roster = await listApartments(); }
  catch (e) { console.error(`roster fetch failed: ${e.message}`); }
  const known = new Set(UNITS.map((u) => u.slug));
  const liveSlugs = new Set(roster.map((a) => a.slug));
  const newOnSite = roster.filter((a) => !known.has(a.slug)).map((a) => ({ slug: a.slug, name: a.name }));
  const goneFromSite = UNITS.filter((u) => roster.length && !liveSlugs.has(u.slug))
                            .map((u) => ({ wp: u.wp, slug: u.slug, name: u.name }));

  const current = {};
  const failed = [];
  await mapLimit(UNITS, cfg.CONCURRENCY, async (u) => {
    let d;
    try { d = await getApartment(u.slug); }
    catch (e) { failed.push(`${u.slug}: ${e.message}`); return; }

    const av = Array.isArray(d.availability) ? d.availability : [];
    if (!av.length) return;                       // no calendar -> no prices to watch
    if (d.syncStatus && d.syncStatus !== 'success') return;
    if (d.maintenanceMode === true) return;
    // A frozen upstream snapshot would look like a portfolio-wide reprice the day
    // it thaws. Same refusal as the iCal guard (L-094).
    if (d.lastSyncedAt && Date.now() - Date.parse(d.lastSyncedAt) > 48 * 3600 * 1000) return;

    const rows = av
      .filter((a) => typeof a[cfg.RATE_FIELD] === 'number' && a[cfg.RATE_FIELD] > 0)
      .map((a) => ({ date: String(a.date).slice(0, 10), price: a[cfg.RATE_FIELD] }));
    if (rows.length) current[u.wp] = { name: d.name || u.name, ranges: toRanges(rows) };
  });

  const fetched = Object.keys(current).length;
  console.log(`fetched prices for ${fetched}/${UNITS.length} units (${failed.length} failed)`);

  // Refuse to diff a broken harvest — a partial fetch would read as mass delisting.
  if (fetched < UNITS.length * 0.8) {
    console.error(`FATAL: only ${fetched} units fetched — refusing to diff or advance the baseline.`);
    for (const f of failed.slice(0, 10)) console.error(`  ${f}`);
    process.exit(1);
  }

  const first = !fs.existsSync(BASELINE);
  const baseline = first ? {} : JSON.parse(fs.readFileSync(BASELINE, 'utf8')).units || {};

  const diff = diffPrices(baseline, current);
  // Genuinely new/removed LISTINGS are a different signal from a mapped unit
  // gaining or losing prices, so they are reported separately rather than merged.
  diff.newOnSite = newOnSite;
  diff.goneFromSite = goneFromSite;
  // Seeding run: everything is "new", which is not news.
  const msg = first ? null : buildMessage(diff);

  console.log(first
    ? 'baseline seeded — no email on the first run'
    : `changed=${diff.changed.length} added=${diff.added.length} removed=${diff.removed.length} nights=${diff.totalNights}`);
  console.log(`roster: ${roster.length} live | NEW on site: ${newOnSite.length} | GONE from site: ${goneFromSite.length}`);
  for (const n of newOnSite) console.log(`  NEW  ${n.slug}`);
  for (const g of goneFromSite) console.log(`  GONE ${g.wp} ${g.slug}`);
  if (msg) console.log('\n' + msg.emailBody + '\n');

  if (dry) { console.log('dry run — no artifacts, baseline not advanced'); return; }

  fs.writeFileSync(path.join(OUT, 'change-message.json'), JSON.stringify(msg));
  fs.writeFileSync(path.join(OUT, 'changes.json'), JSON.stringify(diff, null, 2));
  fs.writeFileSync(BASELINE, JSON.stringify({
    generatedAt: new Date().toISOString(), unitCount: fetched, units: current,
  }, null, 2));
  console.log(`artifacts written; baseline advanced (${fetched} units)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
