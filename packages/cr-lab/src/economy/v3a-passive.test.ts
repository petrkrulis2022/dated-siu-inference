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
    const r = replayPassive(log);
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
    const r = replayPassive(log);
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
    const r = replayPassive(log);
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
      const r = replayPassive(log);
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
      const r = replayPassive(log);
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
      const r = replayPassive(log);
      expect(r.mismatches).toEqual([]);
      expect(close(r, "D", 1)?.passiveWorkShareBps).toBe(6_666n); // 2,000 units, no claims, of 3,000
      expect(close(r, "D", 2)?.passiveWorkShareBps).toBe((2_500n * 10_000n) / 3_500n); // the later claim counts in full
    });

    it("refuses a kept or given-up claim whose window the log does not record (a log written before this amendment)", () => {
      const r = replayPassive([holdings("D", 0, 1_000n, 1_000n, 1_000n), e("D", { kind: "create", tokenId: "t2", milli: 1n, agu: 1_000n, inKindBy: "D" }), holdings("D", 1, 1_000n, 2_000n)]);
      expect(r.mismatches).toEqual(["D's create of t2 records no claim window (a log written before the D149 lapse amendment)"]);
    });
  });

  it("reports a mismatch when the flows do not reproduce a close's balances, and refuses a log without the valuation fields", () => {
    const bad = replayPassive([holdings("D", 0, 1_000n, 1_000n), holdings("D", 8, 900n, 1_000n)]);
    expect(bad.mismatches[0]).toMatch(/^D at close 8: replayed 1000 µ\$ USDC and 1000 AGU-lab units, logged 900 and 1000/);
    const old = replayPassive([{ ...holdings("D", 0, 1_000n, 1_000n), rate: undefined } as LogEntry]);
    expect(old.mismatches).toEqual(["holdings at close 0 carry no valuation (a log written before D149)"]);
  });
});
