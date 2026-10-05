import { describe, expect, it } from "vitest";
import { D, minorUnitsToUsd, roundHalfUp } from "@touchstone/sdk";
import { claimShareDecimal, claimValueMinorUnits, usdcLegUsd } from "./settle-split.js";

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

describe("claimShareDecimal — the share F1 reports, in integers", () => {
  it("rounds an exact tie up, which a float cannot promise", () => {
    // 29/160 = 0.18125 exactly. Binary floating point stores it a hair below, so the old
    // `(Number(a) / Number(b)).toFixed(4)` printed 0.1812; half-up on the exact value is 0.1813.
    expect(claimShareDecimal(29n, 160n)).toBe("0.1813");
    expect(claimShareDecimal(43n, 160n)).toBe("0.2688");
  });

  it("is always four decimals, with the ends exact", () => {
    expect(claimShareDecimal(0n, 500n)).toBe("0.0000");
    expect(claimShareDecimal(500n, 500n)).toBe("1.0000");
    expect(claimShareDecimal(1n, 2n)).toBe("0.5000");
    expect(claimShareDecimal(3n, 0n)).toBe("0"); // a quote with no price has no share
  });

  it("agrees with the SDK's decimal library over thousands of generated pairs", () => {
    // An independent reference: exact decimal division, half-up at four places. Not the same
    // algorithm as the code under test, so it cannot share its mistakes.
    let seed = 99n;
    const next = (mod: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return seed % mod;
    };
    for (let i = 0; i < 5000; i++) {
      const quoted = 1n + next(2_000_000_000n);
      const claim = next(quoted + 1n);
      const reference = roundHalfUp(new D(claim.toString()).dividedBy(quoted.toString()), 4);
      expect(claimShareDecimal(claim, quoted), `${claim}/${quoted}`).toBe(reference);
    }
  });
});

describe("usdcLegUsd — the dollar leg's spend, as an exact decimal string", () => {
  it("is the quote's price less the claim leg's value, never negative", () => {
    expect(usdcLegUsd(14_200n, 5_000n)).toBe("0.009200");
    expect(usdcLegUsd(14_200n, 14_200n)).toBe("0.000000");
    expect(usdcLegUsd(5_000n, 14_200n)).toBe("0.000000");
  });

  it("matches the SDK's own minor-unit formatter for any leg", () => {
    for (const leg of [0n, 1n, 999_999n, 1_000_000n, 123_456_789n, 9_007_199_254_740_993n]) {
      expect(usdcLegUsd(leg, 0n)).toBe(minorUnitsToUsd(leg.toString()));
    }
  });
});
