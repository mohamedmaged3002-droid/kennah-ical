#!/usr/bin/env node
// Fail the run when a published feed has gone stale.
//
// Deliberately the LAST step in CI: it must never be able to cost us the commit
// of freshly-built feeds (L-062 — outward-facing step goes last). A red run here
// means the feeds published fine but at least one unit is serving old
// availability to the OTAs, which is the double-booking failure mode.
const fs = require('fs');
const path = require('path');

const DOCS = path.join(__dirname, 'docs');

const MAX_AGE_HOURS = Number(process.env.STALE_MAX_AGE_HOURS || 24);

const { properties = [] } = JSON.parse(fs.readFileSync(path.join(__dirname, 'docs', 'index.json'), 'utf8'));
const now = Date.now();
const stale = [];
const held = [];
for (const p of properties) {
  // A feed can only be STALE if it is actually being served. A unit the guard is
  // holding has no .ics at all — that is a different condition, already reported
  // in report.json -> skipped[], and it must not fail this run every hour forever.
  // (92006 did exactly that: its .ics was deleted as wrong, but its index entry
  // kept the updatedAt from before the deletion, so this alarmed on a phantom.)
  if (!fs.existsSync(path.join(DOCS, `${p.wp}.ics`))) { held.push(p); continue; }
  if (p.neverWritten) continue; // never published — not stale, just absent
  // Alarm on the age of the DATA, not the age of our own write. sync.js resets
  // updatedAt to now on every successful write, so a feed rebuilt hourly from a
  // month-old upstream snapshot would look eternally fresh by that measure.
  // lastSyncedAt is Kennah's own stamp and is the honest signal.
  const stampedAt = p.lastSyncedAt || p.updatedAt;
  if (!stampedAt) continue;
  const ageH = (now - Date.parse(stampedAt)) / 36e5;
  if (ageH > MAX_AGE_HOURS) {
    stale.push({ wp: p.wp, slug: p.slug, ageHours: Math.round(ageH),
                 basis: p.lastSyncedAt ? 'upstream lastSyncedAt' : 'our updatedAt' });
  }
}
if (held.length) {
  console.log(`${held.length} unit(s) held with no published feed (see report.json -> skipped[]):`);
  for (const h of held) console.log(`  ${h.wp} ${h.slug}`);
}
if (stale.length) {
  console.error(`STALE FEEDS (> ${MAX_AGE_HOURS}h):`);
  for (const s of stale) console.error(`  ${s.wp} ${s.slug} — ${s.ageHours}h old (${s.basis})`);
  process.exit(1);
}
// Count what is actually on disk, not what the index claims. The index flag can
// lag reality by a run; the files cannot.
const served = properties.filter((p) => fs.existsSync(path.join(DOCS, `${p.wp}.ics`))).length;
console.log(`All ${served} published feeds fresh (< ${MAX_AGE_HOURS}h).`);
