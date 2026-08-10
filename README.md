# kennah-ical

Turns [kennahstays.com](https://www.kennahstays.com) availability into per-unit iCal
feeds for BlueKeys calendar sync, and pushes its nightly rates into
`unit_daily_prices`.

Kennah publishes no operator feed, so this is a **bridge** — the same pattern as
`brassbell-ical` and `soul-ical`: read the operator, synthesise `.ics`, serve it on
GitHub Pages, wire the URL into Supabase `listing_ical`.

```
kennahstays.com/api/front  ──►  sync.js  ──►  docs/{wp}.ics  ──►  GitHub Pages
                                    │                                  │
                                    └──► prices-sync.js ──► unit_daily_prices
                                                      wire.js ──► listing_ical
```

## Why this one is cheap

Brassbell needs a Playwright probe costing one request per *unit × night*. Kennah
returns **all 366 nights of a unit in a single GET**, so a full run is ~62 requests
and a few seconds. That is why this runs **hourly** where brassbell runs every 2h.
If a change ever tempts you into per-night requests, you have thrown that away.

## Layout

| Path | What |
|---|---|
| `sync.js` | Fetch availability, build `docs/{wp}.ics` |
| `prices-sync.js` | OTA rate × pinned FX 50 → `unit_daily_prices` |
| `wire.js` | Point `listing_ical` at the published feeds |
| `check-stale.js` | Fail CI when a feed goes stale (runs last) |
| `data/units.json` | slug ↔ `wp_post_id` map (92001–92062) |
| `docs/` | GitHub Pages root — the served `.ics` files + `index.json` |
| `src/guard.js` | The fail-closed write gate. **Read this before changing sync.** |

## Feeds

`https://mohamedmaged3002-droid.github.io/kennah-ical/{wp_post_id}.ics`

`docs/index.json` carries per-unit state (`availableCount`, `collapseStreak`,
`updatedAt`); `docs/report.json` carries the last run's `skipped[]`,
`missingFromRoster[]` and `unmappedOnSite[]`.

## The safety rule

The feed emits **only blocked dates**, so any night we fail to classify publishes as
**OPEN** — and an over-open feed is how the OTAs resell a night Kennah already sold.
Every gate in `src/guard.js` therefore fails **closed**: on doubt we keep serving the
last-good `.ics` and name the unit in `report.json`. Refusing a write is cheap;
a wrong write costs a double-booking.

Five gates: `fetch-not-ok`, `no-availability-data`, `zero-classified`,
`low-coverage` (< 95% of 366), and `availability-collapse` (a >50% drop, refused
until 3 consecutive runs agree — so a genuine off-sale still lands instead of
deadlocking the feed forever, which is what stranded brassbell wp 70149 on a
39-day-stale calendar, L-074).

### The 6 units that deliberately have no feed

Kennah's Maadi "serviced apartment" listings return `availability: []` — they sit
outside its PMS sync. An empty array means *we know nothing*, not *everything is
free*, so the guard refuses them and no `.ics` is written. They must stay **draft**
in Supabase: publishing them would advertise 366 open nights with nothing behind it.

wp `92009`, `92010`, `92021`, `92027`, `92028`, `92033`.

## Pricing

Nightly EGP = `availability[].originalPrice` **× 50**.

- `originalPrice` is Kennah's **OTA rate**. Their `price` field is the same number
  less a flat 10% website discount — we deliberately do not undercut their own
  Airbnb/Booking listings (decision 2026-08-10).
- FX 50 is **pinned**, not live. A moving rate would rewrite every future night on
  every run and bury real operator price changes in the diff.
- `unit_daily_prices` (PK `wp_post_id` + `date`) is the only guest-facing price
  source; a date with no row renders BLOCKED with a WhatsApp CTA.

## Privacy — do not undo this

Kennah's **unauthenticated** detail endpoint also returns:

- `washList[].user` — guest `email`, `phoneNumber`, `password` hash, `idNumber`,
  `passportImage` (a link to a passport scan), `address`, `age`, `resetToken`
- `reservations[]` — guest booking records with dates, party size and amounts paid

That is Kennah's leak, but it becomes **our** liability the moment we persist it.
`src/api.js` strips both fields at the network boundary so nothing downstream can
ever see them. Keep the strip there — not in a caller.

## Run locally

```bash
npm ci
npm test
node sync.js                  # writes docs/, no credentials needed
node prices-sync.js --dry-run # preview price rows
```

`wire.js` and `prices-sync.js` (without `--dry-run`) need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` — see `.env.example`.

## Delist detection

A `.ics` on Pages stays HTTP 200 and well-formed forever, so reachability proves
nothing (L-013, L-064). The liveness test is **membership in the live roster**:
`sync.js` diffs `data/units.json` against `/api/front/apartments` and reports
`missingFromRoster[]` (candidate delist) and `unmappedOnSite[]` (new unit needing a
`wp_post_id`).
