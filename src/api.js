const cfg = require('./config');

async function getJson(path) {
  const url = `${cfg.API_BASE}/${path}`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), cfg.REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'User-Agent': cfg.USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

const listApartments = () => getJson('apartments');

// PRIVACY: Kennah's detail endpoint also returns washList[].user (email, phone,
// password hash, idNumber, passportImage) and reservations[] (guest booking
// records). That is their leak, but it becomes our liability the moment we
// persist it. Strip both here, at the boundary, so nothing downstream can ever
// see them — do not move this into a caller.
const PII_DROP = ['washList', 'reservations'];

async function getApartment(slug) {
  let d = await getJson(`apartments/${encodeURIComponent(slug)}`);
  if (Array.isArray(d)) d = d[0] || {};
  for (const k of PII_DROP) delete d[k];
  return d;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }));
  return out;
}
module.exports = { getJson, listApartments, getApartment, mapLimit, PII_DROP };
