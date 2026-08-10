// Decide whether a fresh API result may overwrite a unit's last-good .ics.
//
// The asymmetry that drives every rule here: this feed emits ONLY blocked dates,
// so any night we fail to classify publishes as OPEN. A bad write therefore fails
// in the dangerous direction — the OTA resells a night Kennah already sold, and
// Maged eats the double-booking. Refusing to write is nearly free by comparison:
// the last-good .ics keeps serving and the unit is named in docs/report.json.
// So every gate below fails CLOSED.
//
// prev:    { availableCount, collapseStreak } from the previous index entry, or null
// current: { ok, nights, blocked, available }
// Returns  { write, reason, collapseStreak } — the caller MUST persist
// collapseStreak even when write is false, or the collapse gate can never confirm.

const COLLAPSE_CONFIRM_RUNS = 3;

// How stale Kennah's OWN sync may be before we stop believing its calendar.
// Kennah re-syncs from its PMS and stamps `lastSyncedAt`; the availability array
// is a SNAPSHOT anchored at that moment, not a rolling window from today.
const MAX_UPSTREAM_AGE_MS = 48 * 3600 * 1000;
// How far the calendar's first night may lag today before the snapshot is
// obviously historical rather than current.
const MAX_ANCHOR_LAG_DAYS = 2;

function shouldWrite(prev, current, expectedNights) {
  const { ok, nights, blocked, available,
          syncStatus, lastSyncedAt, maintenanceMode, firstDate, now = Date.now() } = current;

  // Any unhealthy exit resets the streak. The collapse confirmation below is only
  // meaningful because a REAL off-sale repeats identically run after run, so a
  // broken fetch must never be able to confirm itself.
  if (!ok) return { write: false, reason: 'fetch-not-ok', collapseStreak: 0 };

  // Kennah's 6 Maadi "serviced apartment" listings return availability: [] —
  // they sit outside its PMS sync. An empty array is NOT "everything is free";
  // it is "we know nothing". Publishing it would emit a calendar with zero
  // BLOCKED events, i.e. a unit advertised as open for all 366 nights.
  if (nights === 0) return { write: false, reason: 'no-availability-data', collapseStreak: 0 };

  // Kennah flags a listing it has taken out of service. It correlates exactly with
  // the 6 zero-availability units today, so it is a free second signal for the same
  // state — caught one field earlier, and it would still fire if such a unit ever
  // shipped a stale non-empty calendar.
  if (maintenanceMode === true) return { write: false, reason: 'maintenance-mode', collapseStreak: 0 };

  // A FROZEN UPSTREAM SYNC IS THE WORST CASE THIS BRIDGE FACES, because it is the
  // one that looks perfectly healthy. wp 92006 shipped `syncStatus: "success"` with
  // `lastSyncedAt` 39 days old and a calendar anchored at 2026-07-02 — every night
  // it described was already in the past, so the generated .ics held a single
  // expired VEVENT and advertised all 366 FUTURE nights as open. Full coverage,
  // no errors, fresh DTSTAMP, green everywhere. Trust the data's age, not its shape.
  if (syncStatus && syncStatus !== 'success') {
    return { write: false, reason: `upstream-sync-${syncStatus}`, collapseStreak: 0 };
  }
  if (lastSyncedAt) {
    const age = now - Date.parse(lastSyncedAt);
    if (!Number.isFinite(age) || age > MAX_UPSTREAM_AGE_MS) {
      return { write: false, reason: 'upstream-sync-stale', collapseStreak: 0 };
    }
  }
  if (firstDate) {
    const lagDays = (now - Date.parse(`${firstDate}T00:00:00Z`)) / 864e5;
    if (lagDays > MAX_ANCHOR_LAG_DAYS) {
      return { write: false, reason: 'calendar-anchored-in-past', collapseStreak: 0 };
    }
  }

  const classified = blocked + available;
  if (classified === 0) return { write: false, reason: 'zero-classified', collapseStreak: 0 };

  // Demand a near-complete calendar. A truncated response would silently re-open
  // every night it omitted.
  if (classified < expectedNights * 0.95) {
    return { write: false, reason: 'low-coverage', collapseStreak: 0 };
  }

  // BLOCK-LOSS GATE — the mirror of the collapse gate, and the one that actually
  // guards the dangerous direction. `available = nights - blocked` by construction,
  // so `classified === nights` always and the coverage gates above have ZERO power
  // to notice blocked nights vanishing. Without this, a run reporting blocked = 0
  // on a unit that had 230 sold nights writes cleanly and re-opens all of them.
  // Same streak discipline as the collapse gate so a genuinely-emptying calendar
  // still lands after enough agreeing runs instead of deadlocking.
  if (prev && typeof prev.blocked === 'number' && prev.blocked > 0) {
    if (blocked < prev.blocked * 0.5) {
      const streak = (prev.collapseStreak || 0) + 1;
      if (streak >= COLLAPSE_CONFIRM_RUNS) {
        return { write: true, reason: 'block-loss-confirmed', collapseStreak: 0 };
      }
      return { write: false, reason: 'block-loss', collapseStreak: streak };
    }
  }

  if (prev && typeof prev.availableCount === 'number' && prev.availableCount > 0) {
    if (available < prev.availableCount * 0.5) {
      // A halving of availability is usually a glitch — but it is also exactly what
      // a unit going off-sale looks like, and that state is permanent. This is the
      // one gate whose suppression fails OPEN, and its baseline (prev.availableCount)
      // only refreshes when we write, so refusing forever deadlocks the feed on a
      // stale calendar. Brassbell wp 70149 served a 39-day-stale "August is open"
      // feed exactly this way (L-074).
      //
      // So: refuse on first sight, but count agreeing observations and accept once
      // enough runs concur. A false confirmation costs bookings (unit reads blocked)
      // — the safe direction — and self-heals, because writing sets availableCount
      // to 0 and disables this gate until availability returns.
      const streak = (prev.collapseStreak || 0) + 1;
      if (streak >= COLLAPSE_CONFIRM_RUNS) {
        return { write: true, reason: 'availability-collapse-confirmed', collapseStreak: 0 };
      }
      return { write: false, reason: 'availability-collapse', collapseStreak: streak };
    }
  }
  return { write: true, reason: 'ok', collapseStreak: 0 };
}
module.exports = { shouldWrite, COLLAPSE_CONFIRM_RUNS, MAX_UPSTREAM_AGE_MS, MAX_ANCHOR_LAG_DAYS };
