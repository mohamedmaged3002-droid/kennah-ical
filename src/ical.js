const { ymd, parseIso } = require('./dates');

function esc(text) {
  return String(text || '').replace(/[\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
}
function icalStamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// { wp, title, ranges:[{start, endExclusive}] } -> iCal text (\r\n terminated).
function buildIcal({ wp, title, ranges = [] }) {
  const stamp = icalStamp();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BlueKeys Kennah iCal Bridge//EN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(title)}`,
    'CALSCALE:GREGORIAN',
  ];
  for (const r of ranges) {
    const startYmd = ymd(parseIso(r.start));
    const endYmd = ymd(parseIso(r.endExclusive));
    lines.push(
      'BEGIN:VEVENT',
      // UID encodes start+end so ANY change to a range yields a new event. OTAs
      // that sync incrementally by UID then drop the old block and add the new
      // one instead of seeing a familiar UID and calling it unchanged.
      // (kixedo/brassbell learned this the hard way — see reference_kixedo_ical_mynt.)
      `UID:kennah-${wp}-${startYmd}-${endYmd}@bluekeys.co`,
      // DTSTAMP is required by RFC 5545; with LAST-MODIFIED it is the signal
      // importers use to notice the event changed.
      `DTSTAMP:${stamp}`,
      `LAST-MODIFIED:${stamp}`,
      'SEQUENCE:0',
      `DTSTART;VALUE=DATE:${startYmd}`,
      `DTEND;VALUE=DATE:${endYmd}`,
      'SUMMARY:BLOCKED',
      'STATUS:CONFIRMED',
      'TRANSP:OPAQUE',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
module.exports = { buildIcal, icalStamp };
