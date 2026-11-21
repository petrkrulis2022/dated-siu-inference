import { describe, expect, it } from "vitest";
import { SpendTally } from "./spend-tally.js";

// Realized inference spend, totalled without floating point (invariant 4): exact per-call costs summed as decimals, the totals held as integer
// micro-dollars, rounded half-up once, when read. Until 2026-11-21 the loops summed Number(cost) and printed toFixed(6).

describe("SpendTally", () => {
  it("totals exact per-call costs and rounds once, half-up, to whole micro-dollars", () => {
    // Calls of 3 and 7 prompt tokens at $0.25 per 1M: exactly $0.0000025, which is 3 micro-dollars half-up. Summed as floats it read $0.000002.
    const tally = new SpendTally();
    tally.add("0.00000075");
    tally.add("0.00000175");
    expect(tally.totalMicroUsd()).toBe(3n);
    expect(tally.totalUsd()).toBe("0.000003");
  });

  it("keeps a total per provider, each rounded once from its own exact sum, providers in name order", () => {
    const tally = new SpendTally();
    tally.add("0.00000075", "xai");
    tally.add("0.00000175", "xai");
    tally.add("1.2345674", "google");
    expect(tally.byProviderMicroUsd()).toEqual({ google: 1_234_567n, xai: 3n });
    expect(Object.keys(tally.byProviderUsd())).toEqual(["google", "xai"]);
    expect(tally.byProviderUsd()).toEqual({ google: "1.234567", xai: "0.000003" });
    expect(tally.totalUsd()).toBe("1.234570");
  });

  it("reads zero with nothing added", () => {
    const tally = new SpendTally();
    expect(tally.totalMicroUsd()).toBe(0n);
    expect(tally.totalUsd()).toBe("0.000000");
    expect(tally.byProviderUsd()).toEqual({});
  });

  it("refuses a negative or non-decimal amount", () => {
    const tally = new SpendTally();
    expect(() => tally.add("-0.01")).toThrow(/-0.01/);
    expect(() => tally.add("NaN")).toThrow(/NaN/);
    expect(() => tally.add("abc")).toThrow(/abc/);
  });
});
