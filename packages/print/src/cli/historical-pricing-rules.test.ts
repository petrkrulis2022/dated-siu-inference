import { describe, expect, it } from "vitest";
import { historicalPricingRulesFor } from "./historical-pricing-rules.js";

describe("historicalPricingRulesFor", () => {
  it("reasoning-token pricing: off through 2026-09-08, on from 2026-09-09", () => {
    expect(historicalPricingRulesFor("2026-08-30").reasoningTokensPriced).toBe(false);
    expect(historicalPricingRulesFor("2026-09-08").reasoningTokensPriced).toBe(false);
    expect(historicalPricingRulesFor("2026-09-09").reasoningTokensPriced).toBe(true);
  });

  it("cached-input pricing: off through 2026-09-25, on from 2026-09-26", () => {
    // Deliberately NOT 2026-09-25 (the commit's own date) — that print's own recomputation
    // (verify-all.ts's real sweep) confirmed it was still computed under the old, unpriced
    // behaviour despite the fix landing the same calendar day. See this file's own doc comment.
    expect(historicalPricingRulesFor("2026-09-14").cachedInputPriced).toBe(false);
    expect(historicalPricingRulesFor("2026-09-25").cachedInputPriced).toBe(false);
    expect(historicalPricingRulesFor("2026-09-26").cachedInputPriced).toBe(true);
  });

  it("both rules are independent of each other", () => {
    const early = historicalPricingRulesFor("2026-08-18");
    expect(early.reasoningTokensPriced).toBe(false);
    expect(early.cachedInputPriced).toBe(false);

    const between = historicalPricingRulesFor("2026-09-20");
    expect(between.reasoningTokensPriced).toBe(true);
    expect(between.cachedInputPriced).toBe(false);

    const current = historicalPricingRulesFor("2026-09-27");
    expect(current.reasoningTokensPriced).toBe(true);
    expect(current.cachedInputPriced).toBe(true);
  });
});
