/**
 * D149 item 5 (owner, 2026-11-18): the store-of-value passive benchmark -- the work share an agent would hold had it spent both currencies in proportion to its holdings
 * and made no conversions, with receipts counted as they arrived. Valuation here is 1 µ$ = 1 µSIU and 1 AGU-lab unit = 1 µSIU, so the arithmetic reads directly.
 */
import { describe, expect, it } from "vitest";
import type { LogEntry } from "./log.js";
import { replayPassive } from "./v3a-passive.js";

let seq = 0;
const e = (actor: string, rest: Partial<LogEntry>, window = "d1"): LogEntry =>
  ({ seq: ++seq, window, round: 0, actor, backend: "stand-in", kind: "notice", ...rest }) as LogEntry;
const VAL = { rate: 1_000_000_000n, navNum: 1n, navDen: 1n, shadowPpm: 1_000_000n };
const holdings = (actor: string, atClose: number, usdc: bigint, agu: bigint, claims = 0n, role = "demand"): LogEntry => {
  const total = usdc + agu + claims;
  return e(actor, {
    kind: "holdings",
    atClose,
    role,
    usdc,
    agu,
    claimsMicroSiu: claims,
    workShareBps: total === 0n ? null : ((agu + claims) * 10_000n) / total,
    workShareBpsShadow: total === 0n ? null : ((agu + claims) * 10_000n) / total,
    ...VAL,
  });
};
const close = (r: ReturnType<typeof replayPassive>, agent: string, k: number) => r.closes.find((c) => c.agent === agent && c.atClose === k);

describe("replayPassive", () => {
  it("spends pro rata, ignores conversions, counts receipts as they arrived, and reconstructs the actual balances exactly", () => {
    const log = [
      holdings("D", 0, 1_000n, 1_000n),
      holdings("R", 0, 1_000n, 1_000n, 0n, "research"),
      // D pays 400 µ$ for a brief: the passive D pays 200 µ$ and 200 units of AGU-lab instead
      e("D", { kind: "escrow-open", escrow: "escrow-1", quote: "quote-1", to: "R", usdc: 400n }),
      e("GATE-RUNNER", { kind: "escrow-settle", escrow: "escrow-1", paid: 400n, refunded: 0n }),
      // D buys AGU-lab from the participant: a conversion, which the passive D does not make
      e("participant", { kind: "participant-sell", to: "D", agu: 100n, usdc: 100n, asked: 100n }),
      // R pays D 200 units of AGU-lab back: a receipt in AGU-lab, for both
      e("R", { kind: "wallet-transfer", to: "D", agu: 200n, for: "claim work repaid", ref: "quote-1" }),
      holdings("D", 8, 500n, 1_300n),
      holdings("R", 8, 1_400n, 800n, 0n, "research"),
    ];
    const r = replayPassive(log, "pro-rata");
    expect(r.mismatches).toEqual([]);
    expect(close(r, "D", 8)).toMatchObject({ workShareBps: 7_222n, passiveWorkShareBps: 5_555n }); // 1,300 of 1,800 against 1,000 of 1,800
    // R received 400 µ$ (as it arrived, in USDC), then paid 200 µSIU of value pro rata to what it held then (1,400 µ$ and 1,000 units): 116 µ$ and 84 units
    expect(close(r, "R", 8)?.passiveWorkShareBps).toBe((916n * 10_000n) / 2_200n);
    expect(r.conversions.get("D")).toMatchObject({ buys: 1, buyMicroSiu: 100n, sells: 0, creates: 0, redeems: 0 });
  });

  it("returns an escrow refund in the same mix the passive agent paid it", () => {
    const log = [
      holdings("D", 0, 1_000n, 3_000n),
      e("D", { kind: "escrow-open", escrow: "escrow-2", quote: "quote-2", to: "R", usdc: 400n }),
      e("GATE-RUNNER", { kind: "escrow-settle", escrow: "escrow-2", quote: "quote-2", expired: true, paid: 0n, refunded: 400n }),
      holdings("D", 8, 1_000n, 3_000n),
    ];
    const r = replayPassive(log, "pro-rata");
    expect(r.mismatches).toEqual([]);
    expect(close(r, "D", 8)?.passiveWorkShareBps).toBe(7_500n); // paid 100 µ$ + 300 units, both back: unchanged at 75%
  });

  it("a sale of AGU-lab is a conversion the passive agent does not make; the roll's AGU-lab leg is not a conversion, the roll purchase is a spend", () => {
    const log = [
      holdings("D", 0, 2_000n, 2_000n),
      e("participant", { kind: "participant-buyback", from: "D", agu: 500n, usdc: 500n }),
      e("D", { kind: "exit", agu: 500n, usdc: 500n }), // the same sale, logged twice: counted once
      e("participant", { kind: "participant-buyback", from: "D", agu: 400n, usdc: 400n, forPurchase: "front-claim-order", atMid: true }),
      e("AGU-ISSUER", { kind: "roll-sale", to: "D", tokenId: "t1", milli: 400n, usdc: 400n }),
      holdings("D", 8, 2_500n, 1_100n, 400n),
    ];
    const r = replayPassive(log, "pro-rata");
    expect(r.mismatches).toEqual([]);
    expect(r.conversions.get("D")).toMatchObject({ sells: 1, sellMicroSiu: 500n, buys: 0 });
    // passive: 400 µSIU of value spent pro rata (200 µ$ + 200 units), the claims bought held as by the agent: (1,800 + 400) of 4,000
    expect(close(r, "D", 8)?.passiveWorkShareBps).toBe(5_500n);
  });

  describe("D149 amendment (owner, 2026-11-19): a passive agent never presents, so a claim it holds lapses to zero at its window's close", () => {
    it("a claim kept because the agent created AGU-lab with it counts at face while its window is open, and nothing from that window's close on", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n, 1_000n),
        e("D", { kind: "create", tokenId: "t2", milli: 1n, agu: 1_000n, inKindBy: "D", forWindow: 2 }),
        holdings("D", 1, 1_000n, 2_000n),
        holdings("D", 2, 1_000n, 2_000n),
        holdings("D", 3, 1_000n, 2_000n),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(6_666n); // 1,000 units + the 1,000 claim, of 3,000
      expect(close(r, "D", 2)?.passiveWorkShareBps).toBe(5_000n); // window 2 closed: the claim lapsed, 1,000 of 2,000
      expect(close(r, "D", 3)?.passiveWorkShareBps).toBe(5_000n);
    });

    it("a claim kept instead of a sweep's forced sale counts at face (not at the participant's bid) until its window closes", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n, 1_000n),
        e("participant", { kind: "claim-transfer", tokenId: "t2", from: "D", to: "participant", milli: 1n, usdc: 900n, forced: "sweep", forWindow: 2, microSiu: 1_000n }),
        holdings("D", 1, 1_900n, 1_000n),
        holdings("D", 2, 1_900n, 1_000n),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(6_666n); // 1,000 units + the 1,000 claim at face, of 3,000
      expect(close(r, "D", 2)?.passiveWorkShareBps).toBe(5_000n);
    });

    it("a claim the passive agent lacks (the agent redeemed for it, the passive agent did not) stops counting against it once its window closes", () => {
      const log = [
        holdings("D", 0, 1_000n, 2_000n),
        e("D", { kind: "redeem", agu: 1_000n, lots: [{ tokenId: "t2", milli: 1n, windowTo: 123, forWindow: 2 }] }),
        holdings("D", 1, 1_000n, 1_000n, 1_000n),
        // D holds a different, later claim at window 2's close (received as a payment)
        holdings("D", 2, 1_000n, 1_000n, 500n),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(6_666n); // 2,000 units, no claims, of 3,000
      expect(close(r, "D", 2)?.passiveWorkShareBps).toBe((2_500n * 10_000n) / 3_500n); // the later claim counts in full
    });

    it("refuses a kept or given-up claim whose window the log does not record (a log written before this amendment)", () => {
      const r = replayPassive([holdings("D", 0, 1_000n, 1_000n, 1_000n), e("D", { kind: "create", tokenId: "t2", milli: 1n, agu: 1_000n, inKindBy: "D" }), holdings("D", 1, 1_000n, 2_000n)], "pro-rata");
      expect(r.mismatches).toEqual(["D's create of t2 records no claim window (a log written before the D149 lapse amendment)"]);
    });
  });

  describe("D150 item 2 (owner, 2026-11-19): the passive agent pays its owner's sweep as the engine does -- USDC first, AGU-lab at the bid only for a shortfall", () => {
    // the bid terms the engine logs with every v3a sweep: the print, the NAV and the participant's spread at that moment (spread 100 bps: the bid on n units is floor(n × 0.995))
    const TERMS = { rate: 1_000_000_000n, navNum: 1n, navDen: 1n, spreadBps: 100n };
    const sweep = (actor: string, atClose: number, paid: bigint, demanded: bigint, extra: Record<string, unknown> = {}, terms: Record<string, unknown> = TERMS) =>
      e(actor, { kind: "sweep", usdc: paid, demanded, forcedClaimsMilli: 0n, shortfall: demanded - paid, to: `OWNER-${actor}`, atClose, forcedAgu: 0n, ...extra, ...terms });
    const receipt = (to: string, usdc: bigint, n: number) => [
      e("R", { kind: "escrow-open", escrow: `escrow-r${n}`, quote: `quote-r${n}`, to, usdc }),
      e("GATE-RUNNER", { kind: "escrow-settle", escrow: `escrow-r${n}`, paid: usdc, refunded: 0n }),
    ];

    it("pays a sweep from USDC when it holds enough, exactly as the agent did: an agent whose only flow is a sweep matches its passive benchmark", () => {
      const log = [holdings("D", 0, 1_000n, 1_000n), sweep("D", 1, 400n, 400n), holdings("D", 1, 600n, 1_000n)];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)).toMatchObject({ workShareBps: 6_250n, passiveWorkShareBps: 6_250n }); // 1,000 of 1,600 for both
      expect(r.conversions.get("D")).toBeUndefined();
    });

    it("short of USDC, sells the fewest AGU-lab units whose bid covers the shortfall, at the terms the sweep logged", () => {
      const log = [
        holdings("D", 0, 300n, 2_000n),
        holdings("R", 0, 2_000n, 0n, 0n, "research"),
        // the agent sells 500 units on its own (a conversion the passive agent does not make), so it pays the sweep from USDC alone
        e("participant", { kind: "participant-buyback", from: "D", agu: 500n, usdc: 500n }),
        sweep("D", 1, 400n, 400n),
        ...receipt("D", 1_000n, 1),
        holdings("D", 1, 1_400n, 1_500n),
        holdings("R", 1, 1_000n, 0n, 0n, "research"),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      // passive: 300 µ$ of USDC, then 101 units at the bid (floor(101 × 0.995) = 100; 100 units would bid 99) for the other 100 µ$; then the 1,000 µ$ receipt
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe((1_899n * 10_000n) / 2_899n);
      expect(r.conversions.get("D")).toMatchObject({ sells: 1, sellMicroSiu: 500n });
    });

    it("then sells the claims it kept instead of a creation, soonest window first, at the participant's bid on face", () => {
      const log = [
        holdings("D", 0, 100n, 100n, 2_000n),
        holdings("R", 0, 2_000n, 0n, 0n, "research"),
        e("D", { kind: "create", tokenId: "t3", milli: 1n, agu: 1_000n, inKindBy: "D", forWindow: 3 }),
        e("D", { kind: "create", tokenId: "t2", milli: 1n, agu: 1_000n, inKindBy: "D", forWindow: 2 }),
        // the agent: 100 µ$, then 302 of its 2,100 units (bid 300) -- the passive agent has 100 µ$, 100 units (bid 99) and the two claims it kept
        e("participant", { kind: "participant-buyback", from: "D", agu: 302n, usdc: 300n, forced: "sweep" }),
        sweep("D", 1, 400n, 400n, { forcedAgu: 302n }),
        ...receipt("D", 1_000n, 1),
        holdings("D", 1, 1_000n, 1_798n),
        holdings("R", 1, 1_000n, 0n, 0n, "research"),
        holdings("D", 2, 1_000n, 1_798n),
        holdings("R", 2, 1_000n, 0n, 0n, "research"),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      // the last 201 µ$ from window 2's kept claim: 203 µSIU of face bid floor(203 × 0.995) = 201, leaving 797 of it and all 1,000 of window 3's
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(((797n + 1_000n) * 10_000n) / (1_000n + 797n + 1_000n));
      // window 2's kept claim lapses at its close; window 3's is still whole
      expect(close(r, "D", 2)?.passiveWorkShareBps).toBe((1_000n * 10_000n) / 2_000n);
    });

    it("leaves a shortfall unpaid when the agent's own sweep was short too: neither has anything left to sell", () => {
      const log = [
        holdings("D", 0, 100n, 100n),
        e("participant", { kind: "participant-buyback", from: "D", agu: 100n, usdc: 99n, forced: "sweep" }),
        sweep("D", 1, 199n, 400n, { forcedAgu: 100n }),
        holdings("D", 1, 0n, 0n),
      ];
      const r = replayPassive(log, "pro-rata");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)).toMatchObject({ workShareBps: null, passiveWorkShareBps: null });
    });

    it("reports n/a when the passive agent would have to sell claims the agent kept (the replay does not track them), or the sweep logged no bid terms", () => {
      const lapsed = [
        holdings("D", 0, 100n, 0n, 1_000n),
        // the agent creates AGU-lab with its window-1 claim; the passive agent keeps the claim, which lapses at close 1
        e("D", { kind: "create", tokenId: "t1", milli: 1n, agu: 1_000n, inKindBy: "D", forWindow: 1 }),
        holdings("D", 1, 100n, 1_000n),
        e("participant", { kind: "participant-buyback", from: "D", agu: 302n, usdc: 300n, forced: "sweep" }),
        sweep("D", 2, 400n, 400n, { forcedAgu: 302n }),
        holdings("D", 2, 0n, 698n),
      ];
      expect(replayPassive(lapsed, "pro-rata").mismatches).toEqual([
        "D's passive benchmark is 300 µ$ short of its owner's sweep at close 2 after its USDC, AGU-lab and the claims it kept, while the agent paid in full: the rest would come from claims the replay does not track",
      ]);
      const old = [holdings("D", 0, 100n, 1_000n), sweep("D", 1, 100n, 400n, {}, {}), holdings("D", 1, 0n, 1_000n)];
      expect(replayPassive(old, "pro-rata").mismatches).toEqual(["D's sweep at close 1 needs AGU-lab sold in the passive benchmark, but records no bid terms (a log written before the D150 sweep fix)"]);
    });
  });

  it("reports a mismatch when the flows do not reproduce a close's balances, and refuses a log without the valuation fields", () => {
    const bad = replayPassive([holdings("D", 0, 1_000n, 1_000n), holdings("D", 8, 900n, 1_000n)], "pro-rata");
    expect(bad.mismatches[0]).toMatch(/^D at close 8: replayed 1000 µ\$ USDC and 1000 AGU-lab units, logged 900 and 1000/);
    const old = replayPassive([{ ...holdings("D", 0, 1_000n, 1_000n), rate: undefined } as LogEntry], "pro-rata");
    expect(old.mismatches).toEqual(["holdings at close 0 carry no valuation (a log written before D149)"]);
  });

  describe("D151 (owner, 2026-11-19): the holding benchmark -- each payment in the agent's own currency, no conversions, and only claims held unused count", () => {
    const mint = (actor: string, tokenId: string, forWindow: number, usdc: bigint, milli = 1n, series = "commodity") =>
      e(actor, { kind: "claim-mint", tokenId, offer: "offer-1", forWindow, series, milli, usdc, payUnit: "usdc" });

    it("pays each payment in the currency the agent paid it in, where D149's benchmark paid it pro rata", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n),
        e("D", { kind: "escrow-open", escrow: "escrow-1", quote: "quote-1", to: "R", usdc: 400n }),
        e("GATE-RUNNER", { kind: "escrow-settle", escrow: "escrow-1", paid: 400n, refunded: 0n }),
        holdings("D", 1, 600n, 1_000n),
      ];
      expect(close(replayPassive(log, "holding"), "D", 1)).toMatchObject({ workShareBps: 6_250n, passiveWorkShareBps: 6_250n });
      expect(close(replayPassive(log, "pro-rata"), "D", 1)?.passiveWorkShareBps).toBe(5_000n); // the spending-mix effect, now descriptive only
    });

    it("a claim bought and later presented for work is spending: the passive agent holds the money while the claim is held, and pays for it when it is used", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n),
        mint("D", "t2", 2, 300n),
        holdings("D", 1, 700n, 1_000n, 1_000n),
        e("ISSUER-C1", { kind: "claim-serve", tokenId: "t2", holder: "D", milli: 1n, passed: true }),
        holdings("D", 2, 700n, 1_000n),
      ];
      const r = replayPassive(log, "holding");
      expect(r.mismatches).toEqual([]);
      // close 1: the agent holds the claim unused (a holding choice); the passive agent holds the 300 µ$ instead
      expect(close(r, "D", 1)).toMatchObject({ workShareBps: 7_407n, passiveWorkShareBps: 5_000n });
      // close 2: the claim was used, so the passive agent paid for it too: the same as the agent
      expect(close(r, "D", 2)).toMatchObject({ workShareBps: 5_882n, passiveWorkShareBps: 5_882n });
      expect(r.claimHolds.get("D")).toEqual({ bought: 1, boughtMilli: 1n, usedMilli: 1n, closedUnusedMilli: 0n });
    });

    it("a failed presentation uses nothing; a claim that lapses or defaults unused leaves the passive agent with the money, and the default payout is the agent's alone", () => {
      const lapse = (outcome: string, usdc: bigint) => [
        holdings("D", 0, 1_000n, 1_000n),
        mint("D", "t2", 2, 300n),
        e("ISSUER-C1", { kind: "claim-serve", tokenId: "t2", holder: "D", milli: 1n, passed: false }),
        holdings("D", 1, 700n, 1_000n, 1_000n),
        e("GATE-RUNNER", { kind: "claim-close", tokenId: "t2", holder: "D", outcome, milli: 1n, usdc }),
        holdings("D", 2, 700n + usdc, 1_000n),
      ];
      const expired = replayPassive(lapse("expired", 0n), "holding");
      expect(expired.mismatches).toEqual([]);
      expect(close(expired, "D", 2)).toMatchObject({ workShareBps: 5_882n, passiveWorkShareBps: 5_000n }); // +8.8 points: holding the claim cost the agent 300 µ$
      expect(expired.claimHolds.get("D")).toEqual({ bought: 1, boughtMilli: 1n, usedMilli: 0n, closedUnusedMilli: 1n });
      const defaulted = replayPassive(lapse("defaulted", 250n), "holding");
      expect(defaulted.mismatches).toEqual([]);
      expect(close(defaulted, "D", 2)).toMatchObject({ workShareBps: (1_000n * 10_000n) / 1_950n, passiveWorkShareBps: 5_000n });
    });

    it("a claim paid into a brief's claim escrow is spending; one returned unused refunds the passive agent and is held again", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n),
        mint("D", "t3", 3, 300n),
        e("D", { kind: "claim-transfer", tokenId: "t3", from: "D", to: "claims-escrow:quote-1", researcher: "R", milli: 1n, quote: "quote-1", forWindow: 3 }),
        holdings("D", 1, 700n, 1_000n),
        e("GATE-RUNNER", { kind: "claim-transfer", tokenId: "t3", from: "claims-escrow:quote-1", to: "D", milli: 1n, quote: "quote-1", settlement: "returned" }),
        holdings("D", 2, 700n, 1_000n, 1_000n),
      ];
      const r = replayPassive(log, "holding");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)).toMatchObject({ workShareBps: 5_882n, passiveWorkShareBps: 5_882n });
      expect(close(r, "D", 2)).toMatchObject({ workShareBps: 7_407n, passiveWorkShareBps: 5_000n });
    });

    it("values a Frontier claim the passive agent did not buy at the close's own prints, exactly as the holdings value it", () => {
      const log = [
        holdings("D", 0, 1_000n, 1_000n),
        e("AGU-ISSUER", { kind: "price", atWindow: 1, commodity: 1_000_000_000n, frontier: 2_000_000_000n }),
        mint("D", "t2", 2, 600n, 1n, "frontier"),
        holdings("D", 1, 400n, 1_000n, 2_000n), // 1 mSIU of Frontier work is 2,000 Commodity µSIU at these prints
      ];
      const r = replayPassive(log, "holding");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(5_000n);
    });

    it("pays a payment the passive agent cannot cover in that currency from the other at value (no spread), and reports it", () => {
      const log = [
        holdings("D", 0, 100n, 1_000n),
        e("participant", { kind: "participant-buyback", from: "D", agu: 500n, usdc: 500n }),
        e("D", { kind: "escrow-open", escrow: "escrow-1", quote: "quote-1", to: "R", usdc: 400n }),
        e("GATE-RUNNER", { kind: "escrow-settle", escrow: "escrow-1", paid: 400n, refunded: 0n }),
        holdings("D", 1, 200n, 500n),
      ];
      const r = replayPassive(log, "holding");
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(10_000n); // 100 µ$ then 300 units at NAV 1: 0 µ$ and 700 units
      expect(r.shortfalls).toEqual([{ agent: "D", what: "escrow-open of quote-1", microSiu: 300n }]);
    });
  });
});
