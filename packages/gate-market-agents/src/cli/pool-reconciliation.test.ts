import { describe, expect, it } from "vitest";
import { reconcilePool, renderPoolReconciliation, type LotExpectation } from "./pool-reconciliation.js";

const LOTS: LotExpectation[] = [
  { agentId: "ISSUER-A", address: "0xAAA", issuanceLimitMilliSiu: 48000n },
  { agentId: "ISSUER-B", address: "0xBBB", issuanceLimitMilliSiu: 32000n },
];
const live = (a: bigint, b: bigint) => new Map([["0xaaa", a], ["0xbbb", b]]);

describe("pool reconciliation at launch", () => {
  it("passes a whole pool quietly", () => {
    const r = reconcilePool(LOTS, live(48000n, 32000n));
    expect(r.whole).toBe(true);
    expect(r.shortfallTotal).toBe(0n);
    expect(renderPoolReconciliation(r, "--allow-partial-pool")).toMatch(/Pool reconciled: 80000/);
  });

  it("catches the exact carry-over that went unnoticed on 2026-10-03", () => {
    // A debug run crashed on window 1 having minted 10,000 mSIU, never reached its close-out,
    // and the next run started at 70,000 of 80,000 without saying so. This is that run's
    // launch state.
    const r = reconcilePool(LOTS, live(38000n, 32000n));
    expect(r.whole).toBe(false);
    expect(r.shortfallTotal).toBe(10000n);
    const text = renderPoolReconciliation(r, "--allow-partial-pool");
    expect(text).toMatch(/POOL IS NOT WHOLE AT LAUNCH/);
    expect(text).toMatch(/ISSUER-A 0xAAA: 38000 of 48000, 10000 consumed/);
    expect(text).not.toMatch(/ISSUER-B/); // a whole lot is not listed as a problem
  });

  it("says why it matters, not just that it happened", () => {
    // A bare warning would be read and ignored. The consequence — that scarcity is the thing
    // being measured, so a short start is not comparable — is the part that should stop someone.
    const text = renderPoolReconciliation(reconcilePool(LOTS, live(38000n, 32000n)), "--flag");
    expect(text).toMatch(/not comparable/);
    expect(text).toMatch(/crashed run reaches no sweep/);
    expect(text).toMatch(/--flag/);
  });

  it("reports headroom ABOVE the limit as a louder problem, never as a negative shortfall", () => {
    // Chain and deployment record disagreeing is worse than a leak and must not be clamped away.
    const r = reconcilePool(LOTS, live(50000n, 32000n));
    expect(r.whole).toBe(false);
    expect(r.perIssuer[0]?.shortfall).toBe(-2000n);
    expect(renderPoolReconciliation(r, "--f")).toMatch(/ABOVE its limit.*Do not run/s);
  });

  it("treats an issuer the chain knows nothing about as fully consumed, not as whole", () => {
    // `?? 0n` is deliberate: an unreadable issuer must fail the check rather than pass it.
    const r = reconcilePool(LOTS, new Map([["0xbbb", 32000n]]));
    expect(r.whole).toBe(false);
    expect(r.perIssuer[0]?.actual).toBe(0n);
  });
});
