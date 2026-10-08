import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { checkEndowmentFits, endowmentAllowance, endowmentBound } from "./launch.js";
import { printNano } from "./money.js";
import { reachablePrints } from "./prints.js";

const print = printNano("0.001437"); // illustrative, the one the plan's examples use

describe("the lab's endowment bound (nothing is minted after the opening, D31)", () => {
  it("is four openings, each sized so either asset alone meets every need", () => {
    const b = endowmentBound([print], DEFAULT_PARAMS);
    // D50: fSIU is exactly what the quotes come to in claims, 2 x (1,200 + 1,000). USDC is the larger of that fSIU's value at the print
    // (4,400 x 1.437 = 6,322.8, so 6,323) and what the four quotes cost (2 x (1,725 + 1,437) = 6,324, each rounded up): 6,324.
    expect(b.perTraderMilliSiu).toBe(4_400n);
    expect(b.perTraderUsdcMinor).toBe(6_324n);
    expect(b.perTraderUsdcNeededMinor).toBe(6_324n);
    expect(b.totalMilliSiu).toBe(17_600n);
  });

  it("admits the default economy against ISSUER-B's 32,000 mSIU headroom, inside 80% — with room to spare", () => {
    const check = checkEndowmentFits(endowmentBound([print], DEFAULT_PARAMS), 32_000n);
    expect(check).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
    // The reason minting was removed: with it, the worst case adds eight job claims and eight raw-work claims, 8 x 2,200 = 17,600 more.
    expect(17_600n + 8n * (1_200n + 1_000n)).toBe(35_200n);
    expect(35_200n).toBeGreaterThan(32_000n);
  });

  it("refuses a pool too short for the endowment (an earlier run left claims outstanding), naming both figures", () => {
    const check = checkEndowmentFits(endowmentBound([print], DEFAULT_PARAMS), 20_000n);
    expect(endowmentAllowance(20_000n)).toBe(16_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) {
      expect(check.reason).toContain("17600 mSIU");
      expect(check.reason).toContain("ISSUER-B can back 16000");
    }
  });

  it("scales with the schedule: more needs per trader, a bigger opening", () => {
    const more = endowmentBound([print], { ...DEFAULT_PARAMS, needsPerTrader: 3 });
    expect(more.perTraderMilliSiu).toBe(3n * (1_200n + 1_000n));
  });

  it("refuses to start if USDC alone would not cover every quote", () => {
    const b = endowmentBound([print], DEFAULT_PARAMS);
    const check = checkEndowmentFits({ ...b, perTraderUsdcMinor: b.perTraderUsdcNeededMinor - 1n }, 32_000n);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("USDC alone would not be enough");
  });

  it("with a moving print, sizes USDC at the ceiling and fSIU at what the quotes come to, and still fits ISSUER-B's headroom (D41, D50)", () => {
    const b = endowmentBound(reachablePrints(print, DEFAULT_PARAMS), DEFAULT_PARAMS);
    expect(b.ceilingPrintNano).toBe(1_900_432n);
    // A quote's price in SIU does not move with the print, so the fSIU is the same at every print: 2 x (1,200 + 1,000).
    expect(b.perTraderMilliSiu).toBe(4_400n);
    expect(b.totalMilliSiu).toBe(17_600n); // 55% of ISSUER-B's 32,000 mSIU headroom
    // The USDC covers every quote at the highest print, 1,900,432 nano-USD per SIU: two jobs at $0.002281 and two units at $0.001901 come to
    // 8,364 minor units, two more than the fSIU's value there (4,400 mSIU x 1.900432 = 8,361.9, so 8,362): each quote's dollars round up.
    expect(b.perTraderUsdcMinor).toBe(8_364n);
    expect(b.perTraderUsdcNeededMinor).toBe(8_364n);
    expect(checkEndowmentFits(b, 32_000n)).toEqual({ ok: true, allowanceMilliSiu: 25_600n });
  });
});
