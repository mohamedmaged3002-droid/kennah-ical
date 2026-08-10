#!/usr/bin/env node
// Fail the run when a published feed has gone stale.
//
// Deliberately the LAST step in CI: it must never be able to cost us the commit
// of freshly-built feeds (L-062 — outward-facing step goes last). A red run here
// means the feeds published fine but at least one unit is serving old
// availability to the OTAs, which is the double-booking failure mode.
const fs = require('fs');
const path = require('path');

const MAX_AGE_HOURS = Number(process.env.STALE_MAX_AGE_HOURS || 24);

const { properties = [] } = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', 'index.json'), 'utf8'));
const now = Date.now();
const stale = [];
for (const p of properties) {
  if (p.neverWritten) continue; // never published — not stale, just absent
  if (!p.updatedAt) continue;
  const ageH = (now - Date.parse(p.updatedAt)) / 36e5;
  if (ageH > MAX_AGE_HOURS) stale.push({ wp: p.wp, slug: p.slug, ageHours: Math.round(ageH) });
}
if (stale.length) {
  console.error(`STALE FEEDS (> ${MAX_AGE_HOURS}h):`);
  for (const s of stale) console.error(`  ${s.wp} ${s.slug} — ${s.ageHours}h old`);
  process.exit(1);
}
console.log(`All ${properties.filter((p) => !p.neverWritten).length} published feeds fresh (< ${MAX_AGE_HOURS}h).`);
