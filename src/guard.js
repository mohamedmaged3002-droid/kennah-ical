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

function shouldWrite(prev, current, expectedNights) {
  const { ok, nights, blocked, available } = current;

  // Any unhealthy exit resets the streak. The collapse confirmation below is only
  // meaningful because a REAL off-sale repeats identically run after run, so a
  // broken fetch must never be able to confirm itself.
  if (!ok) return { write: false, reason: 'fetch-not-ok', collapseStreak: 0 };

  // Kennah's 6 Maadi "serviced apartment" listings return availability: [] —
  // they sit outside its PMS sync. An empty array is NOT "everything is free";
  // it is "we know nothing". Publishing it would emit a calendar with zero
  // BLOCKED events, i.e. a unit advertised as open for all 366 nights.
  if (nights === 0) return { write: false, reason: 'no-availability-data', collapseStreak: 0 };

  const classified = blocked + available;
  if (classified === 0) return { write: false, reason: 'zero-classified', collapseStreak: 0 };

  // Demand a near-complete calendar. A truncated response would silently re-open
  // every night it omitted.
  if (classified < expectedNights * 0.95) {
    return { write: false, reason: 'low-coverage', collapseStreak: 0 };
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
module.exports = { shouldWrite, COLLAPSE_CONFIRM_RUNS };
