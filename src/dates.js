function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}
function parseIso(s) { return new Date(`${String(s).slice(0, 10)}T00:00:00Z`); }
function addDays(iso, n) {
  const d = parseIso(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// Collapse a set of blocked NIGHTS into half-open [start, endExclusive) ranges.
// A single blocked night 2026-08-10 becomes DTSTART 20260810 / DTEND 20260811 —
// the RFC 5545 all-day convention every OTA importer expects.
function toRanges(blockedIsoDates) {
  const days = [...new Set(blockedIsoDates)].sort();
  const out = [];
  for (const day of days) {
    const last = out[out.length - 1];
    if (last && last.endExclusive === day) last.endExclusive = addDays(day, 1);
    else out.push({ start: day, endExclusive: addDays(day, 1) });
  }
  return out;
}
module.exports = { ymd, parseIso, addDays, toRanges };
