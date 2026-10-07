import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { checkEndowmentFits, endowmentAllowance, endowmentBound } from "./launch.js";
import { printNano } from "./money.js";
import { reachablePrints } from "./prints.js";

const print = printNano("0.001437"); // illustrative, the one the plan's examples use

describe("the lab's endowment bound (nothing is minted after the opening, D31)", () => {
  it("is four openings, each sized so either asset alone meets every need", () => {
    const b = endowmentBound([print], DEFAULT_PARAMS);
    expect(b.perTraderMilliSiu).toBe(4_318n);
    expect(b.perTraderUsdcMinor).toBe(6_205n);
    expect(b.perTraderUsdcNeededMinor).toBe(6_200n);
    expect(b.totalMilliSiu).toBe(17_272n);
  });

  it("admits the default economy against ISSUER-B's 32,000 mSIU headroom, inside 80% — with room to spare", () => {
    const check = checkEndowmentFits(endowmentBound([print], DEFAULT_PARAMS), 32_000n);
    expect(check).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
    // The reason minting was removed: with it, the worst case adds eight job claims and eight raw-work claims, 17,272 more.
    expect(17_272n + 8n * (1_184n + 975n)).toBe(34_544n);
    expect(34_544n).toBeGreaterThan(32_000n);
  });

  it("refuses a pool too short for the endowment (an earlier run left claims outstanding), naming both figures", () => {
    const check = checkEndowmentFits(endowmentBound([print], DEFAULT_PARAMS), 20_000n);
    expect(endowmentAllowance(20_000n)).toBe(16_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("17272 mSIU");
      expect(check.reason).toContain("ISSUER-B can back 16000");
    }
  });

  it("scales with the schedule: more needs per trader, a bigger opening", () => {
    const more = endowmentBound([print], { ...DEFAULT_PARAMS, needsPerTrader: 3 });
    expect(more.perTraderMilliSiu).toBe(3n * (1_184n + 975n));
  });

  it("refuses to start if USDC alone would not cover every quote", () => {
    const b = endowmentBound([print], DEFAULT_PARAMS);
    const check = checkEndowmentFits({ ...b, perTraderUsdcMinor: b.perTraderUsdcNeededMinor - 1n }, 32_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("USDC alone would not be enough");
  });

  it("with a moving print, sizes USDC at the ceiling and fSIU at the largest claim, and still fits ISSUER-B's headroom (D41)", () => {
    const b = endowmentBound(reachablePrints(print, DEFAULT_PARAMS), DEFAULT_PARAMS);
    expect(b.ceilingPrintNano).toBe(1_900_432n);
    // A job's claim is 1,156 to 1,229 mSIU and a unit of raw work's 964 to 1,029 across the prints the walk can reach (the quote's $0.0001
    // rounding is all that moves them); the opening takes the largest of each: 2 x (1,229 + 1,029).
    expect(b.perTraderMilliSiu).toBe(4_516n);
    expect(b.totalMilliSiu).toBe(18_064n); // 56% of ISSUER-B's 32,000 mSIU headroom
    // The USDC is that fSIU's value at the highest print, 1,900,432 nano-USD per SIU: 8,583 minor units, against 8,400 for every quote at that
    // print (two jobs at $0.0023 and two units at $0.0019).
    expect(b.perTraderUsdcMinor).toBe(8_583n);
    expect(b.perTraderUsdcNeededMinor).toBe(8_400n);
    expect(checkEndowmentFits(b, 32_000n)).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
  });
});
