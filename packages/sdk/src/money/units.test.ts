import { describe, expect, it } from "vitest";
import { minorUnitsToUsd, usdToMinorUnits } from "./units.js";

describe("usdToMinorUnits", () => {
  it("converts an exact 6-decimal USD amount to USDC minor units", () => {
    expect(usdToMinorUnits("0.0676")).toBe("67600");
  });

  it("converts a whole-dollar amount", () => {
    expect(usdToMinorUnits("1")).toBe("1000000");
  });

  it("rounds UP when the USD amount has more precision than the target decimals — never understate a cap", () => {
    // 0.00000001 USD is nonzero but rounds to 0 minor units at 6dp if truncated or half-up'd —
    // ceiling is the only direction that never lets escrow hold less than the quote promised.
    expect(usdToMinorUnits("0.0000001")).toBe("1");
    expect(usdToMinorUnits("0.1234565")).toBe("123457");
  });

  it("supports a non-default decimals count", () => {
    expect(usdToMinorUnits("1.5", 2)).toBe("150");
  });
});

describe("minorUnitsToUsd", () => {
  it("is the exact inverse of usdToMinorUnits for values already at the target precision", () => {
    expect(minorUnitsToUsd("67600")).toBe("0.067600");
  });

  it("round-trips a whole-dollar amount", () => {
    expect(minorUnitsToUsd(usdToMinorUnits("2.50"))).toBe("2.500000");
  });
});
