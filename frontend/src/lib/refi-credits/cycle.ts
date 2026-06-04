/**
 * Cycle math — derived entirely from `meta/refiFinder.planAnniversary` +
 * today's date. We do NOT read `meta/refiFinder.currentCycleId` from
 * Firestore; that field is now stale/ignored on our side.
 *
 * Cycles run from `planAnniversary` of one month to (planAnniversary − 1)
 * of the next. The cycle ID is "YYYY-MM" of the month the cycle STARTED in.
 *
 * With planAnniversary = 19:
 *   May 19 → cycle "2026-05" starts
 *   Jun 18 → still cycle "2026-05"
 *   Jun 19 → cycle "2026-06" starts
 *   Jul 18 → still cycle "2026-06"
 *
 * All math is in UTC because PR bills in UTC and Firestore Timestamps are
 * UTC. Local timezone confusion in cycle math caused subtle off-by-one bugs
 * in a previous iteration — keep this server-side and UTC.
 */

export const BUFFER_CONTACT_RESET = 200;
export const BUFFER_PROPERTY_RESET = 2000;

export function computeCycleId(
  planAnniversary: number,
  now: Date = new Date(),
): string {
  const day = now.getUTCDate();
  const cycleStart =
    day >= planAnniversary
      ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
      : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${cycleStart.getUTCFullYear()}-${String(
    cycleStart.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
}

export function computeCycleStart(
  planAnniversary: number,
  now: Date = new Date(),
): Date {
  const day = now.getUTCDate();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  if (day >= planAnniversary) {
    // Clamp to current month's last day so anniversary 31 in a short month
    // (e.g. Feb 28 / Apr 30) doesn't roll forward into the next month.
    const lastDayThis = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const clamped = Math.min(planAnniversary, lastDayThis);
    return new Date(Date.UTC(y, m, clamped));
  }
  // Same clamp for the PREVIOUS month — fixes the silent overflow where
  // Date.UTC(2026, 1 /*Feb*/, 31) resolves to March 3 today, triggering
  // an early buffer reset for any planAnniversary ∈ [29..31].
  const lastDayPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const clamped = Math.min(planAnniversary, lastDayPrev);
  return new Date(Date.UTC(y, m - 1, clamped));
}
