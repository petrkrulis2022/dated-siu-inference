/**
 * Is the capacity pool actually whole before this run starts?
 *
 * **Why this exists.** §4.6z closed three routes by which capacity leaked *within* a run, and a
 * run's own close-out sweeps what it consumed. Nothing covered a run that **never reaches its
 * close-out**. On 2026-10-03 a debug run crashed on window 1 after minting a 10,000 mSIU claim;
 * its sweep never executed; the claim stayed outstanding; and the next run quietly started with
 * ISSUER-A at 38,000 of 48,000. Nobody noticed until the headroom line was read by hand
 * afterwards, and every subsequent run would have inherited the same shortfall.
 *
 * A carry-over is not necessarily wrong — a claim may legitimately still be live — but it must
 * be a **stated precondition** rather than a silent one, because scarcity is what this testbed
 * measures. Starting 12.5% short without saying so makes every capacity result that run
 * produces incomparable with the last.
 *
 * So: read live headroom, compare against the lots' own issuance limits, and if they differ say
 * exactly how much and against which issuer. The run then refuses to continue unless the
 * operator says the shortfall is expected.
 */
export interface LotExpectation {
  agentId: string;
  address: string;
  issuanceLimitMilliSiu: bigint;
}

export interface PoolReconciliation {
  whole: boolean;
  expectedTotal: bigint;
  actualTotal: bigint;
  shortfallTotal: bigint;
  perIssuer: {
    agentId: string;
    address: string;
    expected: bigint;
    actual: bigint;
    shortfall: bigint;
  }[];
}

/** Pure, so it is testable without a chain. The caller supplies the live readings. */
export function reconcilePool(
  lots: readonly LotExpectation[],
  liveHeadroom: ReadonlyMap<string, bigint>,
): PoolReconciliation {
  const perIssuer = lots.map((l) => {
    const actual = liveHeadroom.get(l.address.toLowerCase()) ?? 0n;
    return {
      agentId: l.agentId,
      address: l.address,
      expected: l.issuanceLimitMilliSiu,
      actual,
      // Negative shortfalls are not clamped away: headroom ABOVE the limit would mean the
      // deployment record and the chain disagree, which is a louder problem than a leak and
      // must not be hidden by a `Math.max`.
      shortfall: l.issuanceLimitMilliSiu - actual,
    };
  });
  const expectedTotal = perIssuer.reduce((s, r) => s + r.expected, 0n);
  const actualTotal = perIssuer.reduce((s, r) => s + r.actual, 0n);
  return {
    whole: perIssuer.every((r) => r.shortfall === 0n),
    expectedTotal,
    actualTotal,
    shortfallTotal: expectedTotal - actualTotal,
    perIssuer,
  };
}

/**
 * What the operator sees. Names the issuer and the amount, and says plainly that the run is
 * not comparable with one that started whole — which is the actual consequence, and the reason
 * a warning alone would not be enough.
 */
export function renderPoolReconciliation(r: PoolReconciliation, flag: string): string {
  if (r.whole) {
    return `Pool reconciled: ${r.actualTotal} mSIU, matching every lot's issuance limit.`;
  }
  const lines = [
    "=== POOL IS NOT WHOLE AT LAUNCH ===",
    `  expected ${r.expectedTotal} mSIU across the lots, found ${r.actualTotal} — ` +
      `short by ${r.shortfallTotal}.`,
  ];
  for (const p of r.perIssuer) {
    if (p.shortfall === 0n) continue;
    lines.push(
      p.shortfall > 0n
        ? `    ${p.agentId} ${p.address}: ${p.actual} of ${p.expected}, ${p.shortfall} consumed`
        : `    ${p.agentId} ${p.address}: ${p.actual} of ${p.expected} — ABOVE its limit, which ` +
          `means the deployment record and the chain disagree. Do not run.`,
    );
  }
  lines.push(
    "  Capacity consumed by an earlier run that never reached its own close-out stays consumed",
    "  (spec §4.6z covers leaks WITHIN a run; a crashed run reaches no sweep at all). Settle or",
    "  expire the outstanding claims, or state that the shortfall is expected.",
    "  Scarcity is what this testbed measures, so a run starting short is not comparable with",
    `  one starting whole. Pass ${flag} to proceed anyway, and the shortfall is recorded.`,
  );
  return lines.join("\n");
}
