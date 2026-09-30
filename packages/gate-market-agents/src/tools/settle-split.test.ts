import { describe, expect, it } from "vitest";
import { claimValueMinorUnits } from "./settle-split.js";

describe("claimValueMinorUnits", () => {
  it("matches a real on-chain settlement exactly", () => {
    // 2026-09-30: three 10,000 mSIU claims defaulted at the 2026-09-29 commodity print
    // ($0.001427/SIU = 1,427,000 nanoUSD/SIU) drew 14,270 USDC minor units each, and
    // WORKER-CODE's balance rose by exactly 42,810. Anchoring the formula to an observed
    // figure rather than to my own derivation of it.
    expect(claimValueMinorUnits("10000", "1427000")).toBe(14_270n);
    expect(claimValueMinorUnits("30000", "1427000")).toBe(42_810n);
  });

  it("is integer maths throughout — invariant 4, no floats in money", () => {
    // A rate that would lose precision in binary floating point.
    expect(claimValueMinorUnits("4000", "1417000")).toBe(5_668n);
    // And it truncates rather than rounding up, so a split can never claim more than it is worth.
    expect(claimValueMinorUnits("1", "1427000")).toBe(1n);
    expect(claimValueMinorUnits("1", "999999")).toBe(0n);
  });

  it("scales linearly, so a split's two legs always sum to the whole", () => {
    const rate = "1427000";
    const whole = claimValueMinorUnits("10000", rate);
    expect(claimValueMinorUnits("7000", rate) + claimValueMinorUnits("3000", rate)).toBe(whole);
  });
});
