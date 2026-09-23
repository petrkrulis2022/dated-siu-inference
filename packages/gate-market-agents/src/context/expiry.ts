/**
 * Spec §7.1a's structural fix for F1's expiry-pressure false-negative risk: "Log time_to_expiry
 * on every hold and redeem decision... so the analysis can demonstrate the separation rather
 * than assert it." Pure, so both `tools/redeem-claim.ts`'s real decision point and WP-7's future
 * turn loop (logging "hold" decisions, which need a live loop to exist at all) compute this the
 * identical way. Clamped at 0 rather than going negative — spec's own framing is "how much
 * runway was left," which is meaningless once the window has already closed.
 */
export function computeTimeToExpirySeconds(
  nowUnixSeconds: bigint,
  windowToUnixSeconds: bigint,
): number {
  const remaining = windowToUnixSeconds - nowUnixSeconds;
  return remaining > 0n ? Number(remaining) : 0;
}
