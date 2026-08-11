#!/usr/bin/env node
// Fetch kennahstays.com availability and publish per-unit iCal feeds to docs/.
//
// Safety posture: this feed emits ONLY blocked dates, so a unit we fail to fetch
// would publish as fully OPEN. We therefore never write a feed we do not trust
// (src/guard.js) and never delete a last-good feed. A refused unit keeps serving
// its previous .ics and is named in docs/report.json -> skipped[].
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { listApartments, getApartment, mapLimit } = require('./src/api');
const { toRanges } = require('./src/dates');
const { buildIcal } = require('./src/ical');
const { shouldWrite } = require('./src/guard');

const DOCS = path.join(__dirname, 'docs');
const UNITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'units.json'), 'utf8'));

function readPrevIndex() {
  const p = path.join(DOCS, 'index.json');
  if (!fs.existsSync(p)) return {};
  try {
    const { properties = [] } = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Object.fromEntries(properties.map((x) => [x.slug, x]));
  } catch { return {}; }
}

async function main() {
  fs.mkdirSync(DOCS, { recursive: true });
  const prevIndex = readPrevIndex();

  // Cross-check the live roster against data/units.json. A slug that vanishes from
  // the roster is the Kennah analogue of the kixedo index-membership signal (L-064):
  // the .ics stays served and valid forever, so absence from the roster — not an
  // HTTP error — is what tells us a unit was delisted.
  let roster = [];
  try {
    roster = (await listApartments()).map((a) => a.slug);
  } catch (e) {
    console.error(`FATAL: could not list apartments: ${e.message}`);
    process.exit(1);
  }
  const rosterSet = new Set(roster);
  const missing = UNITS.filter((u) => !rosterSet.has(u.slug)).map((u) => u.slug);
  const unmapped = roster.filter((s) => !UNITS.some((u) => u.slug === s));

  const results = await mapLimit(UNITS, cfg.CONCURRENCY, async (u) => {
    if (!rosterSet.has(u.slug)) {
      return { ...u, ok: false, reason: 'absent-from-roster', nights: 0, blocked: 0, available: 0 };
    }
    try {
      const d = await getApartment(u.slug);
      const av = Array.isArray(d.availability) ? d.availability : [];
      // `!== true`, NOT `=== false`. Anything that is not an explicit boolean true
      // (null, undefined, a string, a missing key after an upstream schema change)
      // must count as BLOCKED. Under-blocking re-opens a sold night; over-blocking
      // only costs a booking. Kennah ships strict booleans today — this is the
      // guard against the day it stops.
      const blockedDates = av.filter((a) => a.isAvailable !== true).map((a) => String(a.date).slice(0, 10));
      return {
        ...u,
        ok: true,
        nights: av.length,
        blocked: blockedDates.length,
        available: av.length - blockedDates.length,
        blockedDates,
        title: d.name || u.name,
        // Upstream freshness signals — the guard refuses on these.
        syncStatus: d.syncStatus,
        lastSyncedAt: d.lastSyncedAt,
        maintenanceMode: d.maintenanceMode,
        firstDate: av.length ? String(av[0].date).slice(0, 10) : null,
      };
    } catch (e) {
      return { ...u, ok: false, reason: `fetch-failed: ${e.message}`, nights: 0, blocked: 0, available: 0 };
    }
  });

  const properties = [];
  const skipped = [];
  let written = 0;

  for (const r of results) {
    const prev = prevIndex[r.slug] || null;
    const verdict = shouldWrite(prev, r, cfg.EXPECTED_NIGHTS);
    const icsPath = path.join(DOCS, `${r.wp}.ics`);

    if (verdict.write) {
      const ranges = toRanges(r.blockedDates || []);
      fs.writeFileSync(icsPath, buildIcal({ wp: r.wp, title: r.title || r.name, ranges }));
      written++;
      properties.push({
        wp: r.wp, slug: r.slug, name: r.name, internalName: r.internalName,
        area: r.area, compound: r.compound,
        nights: r.nights, blocked: r.blocked, availableCount: r.available,
        ranges: ranges.length, collapseStreak: 0,
        // Persisted so the block-loss gate has a baseline and check-stale.js can
        // alarm on the age of the DATA rather than the age of our own write.
        syncStatus: r.syncStatus || null,
        lastSyncedAt: r.lastSyncedAt || null,
        firstDate: r.firstDate || null,
        updatedAt: new Date().toISOString(),
      });
    } else {
      // Carry the previous entry forward UNCHANGED except collapseStreak, so the
      // stale-feed alarm still sees its real updatedAt and the collapse gate can
      // accumulate agreement across runs.
      skipped.push({ wp: r.wp, slug: r.slug, reason: r.reason || verdict.reason });
      // Carrying prev forward is right while a last-good .ics is still being
      // served. If that file is gone (deleted because it was wrong), its
      // updatedAt describes nothing — keep the counters, drop the timestamp,
      // and say plainly that nothing is published.
      const stillServed = fs.existsSync(icsPath);
      if (prev) properties.push({
        ...prev,
        collapseStreak: verdict.collapseStreak,
        ...(stillServed ? {} : { updatedAt: null, neverWritten: true }),
      });
      else properties.push({
        wp: r.wp, slug: r.slug, name: r.name, internalName: r.internalName,
        area: r.area, compound: r.compound,
        nights: 0, blocked: 0, availableCount: 0, ranges: 0,
        collapseStreak: verdict.collapseStreak, updatedAt: null,
        neverWritten: true,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: cfg.SOURCE,
    rosterCount: roster.length,
    mappedCount: UNITS.length,
    written,
    skipped,
    missingFromRoster: missing,
    unmappedOnSite: unmapped,
  };
  fs.writeFileSync(path.join(DOCS, 'index.json'), JSON.stringify({ ...report, properties }, null, 2));
  fs.writeFileSync(path.join(DOCS, 'report.json'), JSON.stringify(report, null, 2));

  console.log(`roster=${roster.length} mapped=${UNITS.length} written=${written} skipped=${skipped.length}`);
  for (const s of skipped) console.log(`  SKIP ${s.wp} ${s.slug}: ${s.reason}`);
  if (missing.length) console.log(`  MISSING FROM ROSTER (possible delist): ${missing.join(', ')}`);
  if (unmapped.length) console.log(`  NEW ON SITE (needs wp id): ${unmapped.join(', ')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
