import { describe, expect, it } from "vitest";
import {
  categorise,
  enumerateOutstanding,
  isRecoverableNow,
  reconcilePool,
  renderOutstanding,
  renderPoolReconciliation,
  type LotExpectation,
} from "./pool-reconciliation.js";

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

describe("telling a recoverable carry-over from a leak", () => {
  const DAY = 86400;
  const closed = Math.floor(Date.UTC(2026, 9, 2, 18, 0, 0) / 1000); // 2026-10-02T18:00Z
  const now = Math.floor(Date.UTC(2026, 9, 3, 12, 0, 0) / 1000); // next day
  const base = {
    tokenId: "77",
    holder: "0xee18",
    quantityMilliSiu: "10000",
    windowToUnix: closed,
    everPresented: true,
  };

  it("calls a claim whose window is still open LIVE, not a shortfall to chase", () => {
    expect(categorise({ ...base, windowToUnix: now + DAY }, now, new Set())).toBe("live");
  });

  it("separates run 17's legitimate ending from a crash's residue", () => {
    // This is the distinction that keeps --allow-partial-pool from becoming routine. Run 17's
    // last-window claim was presented and simply had no print dated its close day yet; the
    // 14:28 crash left an unpresented claim that settles immediately and pays nobody. A
    // headroom figure alone cannot tell them apart.
    expect(categorise(base, now, new Set())).toBe("blocked_awaiting_print");
    expect(categorise(base, now, new Set(["2026-10-02"]))).toBe("settleable_pays_holder");
    expect(categorise({ ...base, everPresented: false }, now, new Set(["2026-10-02"]))).toBe(
      "settleable_pays_nobody",
    );
  });

  it("marks only the genuinely actionable ones as actionable", () => {
    expect(isRecoverableNow("settleable_pays_holder")).toBe(true);
    expect(isRecoverableNow("settleable_pays_nobody")).toBe(true);
    expect(isRecoverableNow("blocked_awaiting_print")).toBe(false);
    expect(isRecoverableNow("live")).toBe(false);
  });

  it("says a shortfall is EXPECTED when nothing can be acted on", () => {
    const text = renderOutstanding(
      [{ ...base, category: "blocked_awaiting_print" as const }],
      50000,
    );
    expect(text).toMatch(/BLOCKED/);
    expect(text).toMatch(/expected rather than leaked/);
  });

  it("tells the operator to settle when something can be", () => {
    const text = renderOutstanding(
      [{ ...base, everPresented: false, category: "settleable_pays_nobody" as const }],
      50000,
    );
    expect(text).toMatch(/only returns the capacity/);
    expect(text).toMatch(/1 of these can be settled right now/);
  });

  it("refuses to call an unexplained shortfall benign", () => {
    // The dangerous reading: finding nothing and concluding nothing is wrong. The scan is
    // bounded, so absence of evidence here really is just absence.
    const text = renderOutstanding([], 50000);
    expect(text).toMatch(/NOT explained/);
    expect(text).toMatch(/may predate the scan window/);
  });
});

describe("enumerating what is actually holding the capacity", () => {
  const now = Math.floor(Date.UTC(2026, 9, 3, 12, 0, 0) / 1000);
  const closed = BigInt(Math.floor(Date.UTC(2026, 9, 2, 18, 0, 0) / 1000));
  const mk = (over: Partial<Parameters<typeof deps>[0]> = {}) => over;
  function deps(
    minted: { tokenId: bigint; issuer: string; buyer: string; quantity: bigint; windowTo: bigint }[],
    balances: Record<string, bigint> = {},
    presented: Record<string, boolean> = {},
    failChunks = 0,
    mintChunkTo = 100_000n,
  ) {
    let failures = failChunks;
    return {
      latestBlock: async () => 100_000n,
      nowUnix: async () => BigInt(now),
      // The mint lives in the most recent chunk only; every older chunk is empty. Expressed
      // against `to` because `from` is the chunk's LOWER bound and the first chunk's lower
      // bound is already 99_001 — the previous version of this fake tested `from` and so
      // emptied the very chunk it meant to populate.
      mintedIn: async (_from: bigint, to: bigint) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error("rpc hiccup");
        }
        return to === mintChunkTo ? minted : [];
      },
      balanceOf: async (t: bigint) => balances[t.toString()] ?? 10_000n,
      everPresented: async (t: bigint) => presented[t.toString()] ?? false,
    };
  }

  it("finds a held claim and categorises it", async () => {
    const r = await enumerateOutstanding(
      deps([{ tokenId: 77n, issuer: "0xAAA", buyer: "0xee18", quantity: 10_000n, windowTo: closed }]),
      new Map([["0xaaa", "ISSUER-A"]]),
      new Set(),
    );
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]?.issuerAgentId).toBe("ISSUER-A");
    expect(r.claims[0]?.category).toBe("settleable_pays_nobody");
  });

  it("ignores a claim whose holder no longer holds it", async () => {
    // Burned, settled or passed on. Reporting it would send the operator chasing capacity that
    // is not actually consumed.
    const r = await enumerateOutstanding(
      deps(
        [{ tokenId: 77n, issuer: "0xAAA", buyer: "0xee18", quantity: 10_000n, windowTo: closed }],
        { "77": 0n },
      ),
      new Map(),
      new Set(),
    );
    expect(r.claims).toEqual([]);
  });

  it("keeps scanning past an unreadable chunk, and does not count it as scanned", async () => {
    // A flaky endpoint must not silently shrink the search and then be reported as a clean scan.
    const r = await enumerateOutstanding(
      deps(
        [{ tokenId: 77n, issuer: "0xAAA", buyer: "0xee18", quantity: 10_000n, windowTo: closed }],
        {},
        { "77": true },
        2,
        // The mint sits in the THIRD chunk, past both failures, so this really tests that the
        // scan continued rather than that it got lucky in chunk 0.
        98_000n,
      ),
      new Map(),
      new Set(["2026-10-02"]),
      5,
    );
    expect(r.claims[0]?.category).toBe("settleable_pays_holder");
    expect(r.scannedBlocks).toBe(3000); // 5 chunks attempted, 2 failed
  });

  it("does not report the same claim twice when it appears in several chunks", async () => {
    const r = await enumerateOutstanding(
      deps([{ tokenId: 77n, issuer: "0xAAA", buyer: "0xee18", quantity: 10_000n, windowTo: closed }]),
      new Map(),
      new Set(),
      4,
    );
    expect(r.claims).toHaveLength(1);
  });
});
