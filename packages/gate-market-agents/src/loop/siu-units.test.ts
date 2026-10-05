import { describe, expect, it } from "vitest";
import { decimalSiuToMilliSiu, milliSiuToDecimalSiu } from "./siu-units.js";

describe("decimalSiuToMilliSiu", () => {
  it("converts whole and fractional SIU exactly", () => {
    expect(decimalSiuToMilliSiu("10")).toBe("10000");
    expect(decimalSiuToMilliSiu("4")).toBe("4000");
    expect(decimalSiuToMilliSiu("0.004")).toBe("4");
    expect(decimalSiuToMilliSiu("1.5")).toBe("1500");
    expect(decimalSiuToMilliSiu("0.1")).toBe("100");
  });

  it("is exact where a float would not be", () => {
    // 0.1 + 0.2 style traps: 1.005 * 1000 is 1004.9999999999999 in IEEE-754. Integer money maths
    // (invariant 4) means this must be exactly 1005.
    expect(decimalSiuToMilliSiu("1.005")).toBe("1005");
    expect(decimalSiuToMilliSiu("19.999")).toBe("19999");
  });

  it("accepts trailing zeros beyond three places, since they carry no value", () => {
    expect(decimalSiuToMilliSiu("2.5000")).toBe("2500");
  });

  it("REFUSES a fraction of a milli-SIU rather than truncating it", () => {
    // A claim cannot express it, and silently dropping it would settle the quote for less than
    // it states — a quiet underpayment dressed as a rounding detail.
    expect(() => decimalSiuToMilliSiu("1.0005")).toThrow(/fraction of a milli-SIU/);
    expect(() => decimalSiuToMilliSiu("0.0001")).toThrow(/fraction of a milli-SIU/);
  });

  it("refuses zero and anything that is not a plain decimal", () => {
    expect(() => decimalSiuToMilliSiu("0")).toThrow(/zero/);
    expect(() => decimalSiuToMilliSiu("0.000")).toThrow(/zero/);
    for (const bad of ["", "abc", "-1", "1e3", "1,5", "1.", ".5"]) {
      expect(() => decimalSiuToMilliSiu(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("milliSiuToDecimalSiu", () => {
  it("writes whole and fractional SIU exactly", () => {
    expect(milliSiuToDecimalSiu(10_000n)).toBe("10");
    expect(milliSiuToDecimalSiu(4_000n)).toBe("4");
    expect(milliSiuToDecimalSiu(4_500n)).toBe("4.5");
    expect(milliSiuToDecimalSiu(1n)).toBe("0.001");
    expect(milliSiuToDecimalSiu(0n)).toBe("0");
  });

  it("round-trips with decimalSiuToMilliSiu for every whole milli-SIU tried", () => {
    for (const m of [1n, 9n, 10n, 100n, 999n, 1_000n, 1_001n, 12_345n, 4_000n, 10_000n]) {
      expect(decimalSiuToMilliSiu(milliSiuToDecimalSiu(m))).toBe(m.toString());
    }
  });
});
