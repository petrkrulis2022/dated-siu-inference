import { describe, expect, it } from "vitest";
import { estimateTokens, estimatedCeiling, realizedCost } from "./pricing.js";

const PRICES = { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" };

describe("estimateTokens", () => {
  it("is a rough chars/4 heuristic, never zero", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("estimatedCeiling", () => {
  it("prices the point estimate below the cap, both derived from the same real per-token prices", () => {
    const { siu, siuMax } = estimatedCeiling("a".repeat(400), 1000, PRICES, "0.05");
    expect(Number(siu)).toBeGreaterThan(0);
    expect(Number(siuMax)).toBeGreaterThan(Number(siu));
  });

  it("a higher rate_usd_per_siu produces a lower siu figure for the identical underlying task", () => {
    const cheaperRateQuote = estimatedCeiling("a".repeat(400), 1000, PRICES, "0.05");
    const pricierRateQuote = estimatedCeiling("a".repeat(400), 1000, PRICES, "0.10");
    expect(Number(pricierRateQuote.siu)).toBeLessThan(Number(cheaperRateQuote.siu));
  });

  it("scales with maxTokens, since the ceiling must cover the worst case", () => {
    const small = estimatedCeiling("a".repeat(400), 100, PRICES, "0.05");
    const large = estimatedCeiling("a".repeat(400), 10_000, PRICES, "0.05");
    expect(Number(large.siuMax)).toBeGreaterThan(Number(small.siuMax));
  });
});

describe("realizedCost", () => {
  it("matches @touchstone/print's callCost arithmetic directly", () => {
    // 1000 input @ $1/1M + 500 output @ $2/1M = 0.001 + 0.001 = 0.002
    expect(realizedCost(1000, 500, PRICES)).toBe("0.002");
  });

  it("is zero for zero usage", () => {
    expect(realizedCost(0, 0, PRICES)).toBe("0");
  });
});
