#!/usr/bin/env node
// Push Kennah nightly rates into unit_daily_prices.
//
// unit_daily_prices (PK wp_post_id + date) is the ONLY guest-facing price source
// on BlueKeys — the units.price_* buckets are vestigial. A date with no row here
// renders BLOCKED with a WhatsApp CTA, so gaps are safe but lossy.
//
// Rate basis: availability[].originalPrice — Kennah's OTA rate — times a PINNED
// FX of 50. Their availability[].price is the same number less a flat 10%
// website discount; we deliberately do not undercut their own OTA listings.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const cfg = require('./src/config');
const { getApartment, mapLimit } = require('./src/api');
const { getSupabase } = require('./src/supabase');

const UNITS = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'units.json'), 'utf8'));
const CHUNK = 500;

async function main() {
  const dry = process.argv.includes('--dry-run');
  const rows = [];
  const skipped = [];

  await mapLimit(UNITS, cfg.CONCURRENCY, async (u) => {
    let d;
    try { d = await getApartment(u.slug); }
    catch (e) { skipped.push(`${u.slug}: ${e.message}`); return; }

    const av = Array.isArray(d.availability) ? d.availability : [];
    if (!av.length) { skipped.push(`${u.slug}: no availability`); return; }

    // Same staleness refusal as the iCal guard, for the same reason: Kennah's
    // availability array is a snapshot anchored at lastSyncedAt, not a rolling
    // window. wp 92006 was 39 days stale, so its "prices" were a historical
    // calendar. Writing those would price the wrong nights and leave the real
    // future unpriced. Refusing simply leaves the dates BLOCKED, which is safe.
    if (d.syncStatus && d.syncStatus !== 'success') { skipped.push(`${u.slug}: syncStatus=${d.syncStatus}`); return; }
    if (d.maintenanceMode === true) { skipped.push(`${u.slug}: maintenanceMode`); return; }
    if (d.lastSyncedAt && Date.now() - Date.parse(d.lastSyncedAt) > 48 * 3600 * 1000) {
      skipped.push(`${u.slug}: upstream sync stale (${d.lastSyncedAt})`); return;
    }

    const today = new Date().toISOString().slice(0, 10);
    for (const a of av) {
      const usd = a[cfg.RATE_FIELD];
      if (typeof usd !== 'number' || !(usd > 0)) continue;
      // Past dates are unsellable; writing them only bloats the table.
      if (String(a.date).slice(0, 10) < today) continue;
      rows.push({
        wp_post_id: u.wp,
        date: String(a.date).slice(0, 10),
        // unit_daily_prices.price is CHECK (price > 0) — a zero/!finite rate is
        // filtered above rather than sent and rejected mid-chunk.
        price: Math.round(usd * cfg.FX_USD_EGP),
        currency: 'EGP',
        source: cfg.SOURCE, // NOT NULL, no default
      });
    }
  });

  console.log(`${rows.length} price rows from ${UNITS.length - skipped.length} units`);
  for (const s of skipped) console.log(`  SKIP ${s}`);
  if (dry) {
    console.log('dry run — nothing written');
    console.log(JSON.stringify(rows.slice(0, 3), null, 2));
    return;
  }

  const sb = getSupabase();
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from('unit_daily_prices').upsert(chunk, { onConflict: 'wp_post_id,date' });
    if (error) { console.error(`  chunk ${i}: ${error.message}`); continue; }
    written += chunk.length;
  }
  console.log(`Wrote ${written} unit_daily_prices rows.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
