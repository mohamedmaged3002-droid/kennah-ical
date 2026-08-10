// Kennah publishes no operator iCal feed, so we synthesise one from its public
// JSON API — the same bridge pattern as brassbell-ical / soul-ical.
//
// Unlike Brassbell (which needs a Playwright calendar probe, one request per
// unit*night) Kennah hands us all 366 nights of a unit in a SINGLE GET. That is
// ~62 requests per run instead of ~11k, so there is no throttle budget to
// manage and no coarse-to-fine probing. Keep it that way: if a future change
// tempts you into per-night requests, you have lost the reason this repo is
// cheap enough to run hourly.
module.exports = {
  API_BASE: 'https://www.kennahstays.com/api/front',
  PAGES_BASE_URL: 'https://mohamedmaged3002-droid.github.io/kennah-ical',
  SOURCE: 'kennah',

  // Nights we expect the API to return per unit. Kennah serves a rolling 366.
  EXPECTED_NIGHTS: 366,

  // Kennah quotes USD. BlueKeys stores EGP. Pinned rate, deliberately NOT a live
  // FX lookup: a moving rate would rewrite every future night's price on every
  // run and make real operator price changes invisible in the diff. Same pin as
  // brassbell (see D-039 / reference_bluekeys_pricing).
  FX_USD_EGP: 50,

  // We price off Kennah's OTA rate (availability[].originalPrice), NOT their
  // website rate (availability[].price, a flat 10% less). Decision 2026-08-10:
  // sit level with their Airbnb/Booking listings rather than undercut them.
  // The two differ by exactly websiteDiscount on every row we have seen.
  RATE_FIELD: 'originalPrice',

  REQUEST_TIMEOUT_MS: 60000,
  CONCURRENCY: 4,
  USER_AGENT: 'bluekeys-kennah-ical/1.0 (+https://bluekeys.co)',
};
