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
    const cost = realizedTurnCostUsd({ input: 1000, output: 300, cached_input: 0, reasoning: 0 }, HAIKU_PRICES, "anthropic");
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

// realizedTurnCostUsd prices a finished call through the one shared cost function (@touchstone/sdk's callCostUsd), in the harness adapters'
// usage convention for the agent's provider. Before 2026-11-21 it priced input and output only: a Gemini or grok call's reasoning tokens went
// unpriced, and cached tokens were charged at the full input rate.
describe("realizedTurnCostUsd — the shared cost function, in the harness adapters' usage convention", () => {
  const GEMINI = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12", priceCachedInUsdPer1M: "0.2" };

  it("prices the reasoning tokens Google reports apart from the output", () => {
    // A WORKER-EXTRACT turn from the 2026-09-30 p5 run: 8,057 input, 64 output, 4,317 reasoning.
    // 8057 x $2 + (64 + 4317) x $12, per 1M = 0.016114 + 0.052572.
    expect(realizedTurnCostUsd({ input: 8057, output: 64, cached_input: 0, reasoning: 4317 }, GEMINI, "google")).toBe("0.068686");
  });

  it("prices cached tokens counted inside the prompt once, at the cached rate", () => {
    // 10,000-token prompt, 6,000 cached: 4,000 x $2 + 6,000 x $0.20 + 1,000 x $12, per 1M.
    expect(realizedTurnCostUsd({ input: 10_000, output: 1_000, cached_input: 6_000, reasoning: 0 }, GEMINI, "google")).toBe("0.0212");
  });

  it("does not add reasoning OpenAI already counts inside completion_tokens", () => {
    const gpt = { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" };
    expect(realizedTurnCostUsd({ input: 1_000, output: 500, cached_input: 0, reasoning: 300 }, gpt, "openai")).toBe("0.00625");
  });
});
