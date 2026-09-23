import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  isZeroUsd,
  projectedTurnCostUsd,
  realizedTurnCostUsd,
} from "./inference-cost.js";

// claude-haiku-4-5's real price as of data/registry/price-snapshot-merged-2026-09-22 —
// $1/$5 per 1M tokens — used here as a fixed, known input, not re-read from the live registry
// file (that wiring belongs to whoever loads real prices for a real run).
const HAIKU_PRICES = { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" };

describe("projectedTurnCostUsd / realizedTurnCostUsd — built on @touchstone/print's callCost", () => {
  it("computes the same real dollar figure this session's own cost projection used", () => {
    // 1000 input tokens, 300 output tokens, no caching: (1000/1e6)*1 + (300/1e6)*5 = 0.001 + 0.0015
    const cost = realizedTurnCostUsd(1000, 300, HAIKU_PRICES);
    expect(cost).toBe("0.0025");
  });

  it("projectedTurnCostUsd uses the full maxOutputTokens as the worst case, not a point estimate", () => {
    const projected = projectedTurnCostUsd(1000, 1000, HAIKU_PRICES);
    // (1000/1e6)*1 + (1000/1e6)*5 = 0.001 + 0.005
    expect(projected).toBe("0.006");
  });

  it("applies the cached-token discount when supplied — callCost's own existing feature", () => {
    const withCache = projectedTurnCostUsd(1000, 300, HAIKU_PRICES, 800, "0.1");
    // fresh input = 1000 (the full contextTokens arg is the *fresh* portion in this call shape;
    // cachedTokens is additional, priced separately) - see callCost's own real signature.
    // (1000/1e6)*1 + (300/1e6)*5 + (800/1e6)*0.1 = 0.001 + 0.0015 + 0.00008
    expect(withCache).toBe("0.00258");
  });

  it("a call with no caching costs strictly more than the same call with caching", () => {
    const noCaching = projectedTurnCostUsd(5000, 300, HAIKU_PRICES);
    const withCaching = projectedTurnCostUsd(500, 300, HAIKU_PRICES, 4500, "0.1");
    expect(Number(withCaching)).toBeLessThan(Number(noCaching));
  });
});

describe("estimateTokens", () => {
  it("is the same chars/4 heuristic packages/agents/src/pricing.ts already uses", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
    expect(estimateTokens("")).toBe(1); // never zero — max(1, ...)
  });
});

describe("isZeroUsd", () => {
  it("recognizes a literal zero regardless of decimal formatting", () => {
    expect(isZeroUsd("0")).toBe(true);
    expect(isZeroUsd("0.00")).toBe(true);
    expect(isZeroUsd("0.0001")).toBe(false);
  });
});
