import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { cachedTokensInsideInput, callCostOf, type ModelPrice } from "./class-cost.js";
import { computeCostOfProduction } from "./cost-of-production.js";
import { computePrint, type ModelInput, type PrintInput } from "./index.js";
import { computePriceCheck } from "./price-check.js";

// rules-2026-11-21: a cached prompt token is priced once, at the cached rate. Anthropic reports cache reads apart from input_tokens, so its
// usage.input excludes them and the cached term is added; every other provider (OpenAI-shaped prompt_tokens, Google's promptTokenCount) counts
// cached tokens inside usage.input, and the formula before this revision priced them twice for those providers: once inside the prompt at the
// full input rate, then again at the cached rate. Google bills implicitly cached Gemini tokens at the cached rate (checked against the
// 2026-11-19 AI Studio charge at the CNB fixing), so a 43%-cached Gemini day was overstated by about 47%.

// Gemini 3.1 Pro Preview's published list prices (prompts up to 200k tokens): $2 in, $12 out, $0.20 cached.
const GEMINI: ModelPrice = { price_in_usd_per_1m: "2", price_out_usd_per_1m: "12", price_cached_in_usd_per_1m: "0.2" };

function rec(instanceId: string, usage: Partial<RunRecord["usage"]>, over: Partial<RunRecord> = {}, taskClass: RunRecord["task_class"] = "T1"): RunRecord {
  return {
    run_id: `${instanceId}-1`,
    model_id: "m",
    task_class: taskClass,
    instance_id: instanceId,
    seed: 1,
    attempt: 1,
    usage: { input: 0, output: 0, cached_input: 0, reasoning: 0, ...usage },
    latency_ms: 1,
    gate_passed: true,
    raw_response_ref: "r.json",
    deviations: [],
    ...over,
  };
}

describe("cachedTokensInsideInput", () => {
  it("is false only for Anthropic, whose input_tokens exclude cache reads", () => {
    expect(cachedTokensInsideInput("anthropic")).toBe(false);
    for (const provider of ["google", "openai", "openrouter", "xai", "together", "fireworks", "groq"]) {
      expect(cachedTokensInsideInput(provider)).toBe(true);
    }
  });
});

describe("callCostOf (rules-2026-11-21): a cached token is priced once", () => {
  // One 1M-token prompt, 430k of it served from cache.
  const inside = rec("i0", { input: 1_000_000, cached_input: 430_000 });
  const apart = rec("i1", { input: 570_000, cached_input: 430_000 });

  it("prices a prompt counted with its cached tokens inside it at the input rate for the uncached part and the cached rate for the rest", () => {
    // 570k x $2 + 430k x $0.20 = 1.14 + 0.086.
    expect(callCostOf(inside, { price: GEMINI, cachedInsideInput: true }).toString()).toBe("1.226");
  });

  it("prices the same prompt the same way when the provider reports its cached tokens apart from the input (Anthropic)", () => {
    expect(callCostOf(apart, { price: GEMINI, cachedInsideInput: false }).toString()).toBe("1.226");
    expect(callCostOf(apart, { price: GEMINI }).toString()).toBe("1.226");
  });

  it("keeps the earlier formula when the rule is off, so a print computed before it recomputes as published", () => {
    // 1M x $2 + 430k x $0.20: every cached token counted twice.
    expect(callCostOf(inside, { price: GEMINI }).toString()).toBe("2.086");
  });

  it("prices the whole prompt at the input rate when no cached rate is published, as before", () => {
    const noCachedRate = { price_in_usd_per_1m: "2", price_out_usd_per_1m: "12" };
    expect(callCostOf(inside, { price: noCachedRate, cachedInsideInput: true }).toString()).toBe("2");
  });

  it("prices output and reasoning tokens as before", () => {
    const call = rec("i2", { input: 1_000_000, cached_input: 430_000, output: 100_000, reasoning: 50_000 });
    // 1.226 + 150k x $12 = 1.226 + 1.8.
    expect(callCostOf(call, { price: GEMINI, cachedInsideInput: true }).toString()).toBe("3.026");
  });

  it("uses the cached rate of the tier the response reports", () => {
    const priority: ModelPrice = { price_in_usd_per_1m: "3", price_out_usd_per_1m: "18", price_cached_in_usd_per_1m: "0.3" };
    const call = rec("i3", { input: 1_000_000, cached_input: 430_000 }, { service_tier: "priority" });
    // 570k x $3 + 430k x $0.30 = 1.71 + 0.129.
    expect(callCostOf(call, { price: GEMINI, tierPrices: { priority }, cachedInsideInput: true }).toString()).toBe("1.839");
  });

  it("still prices a billed call at its billed figure", () => {
    const call = rec("i4", { input: 1_000_000, cached_input: 430_000 }, { billed_usd: "1.2" });
    expect(callCostOf(call, { price: GEMINI, billed: true, cachedInsideInput: true }).toString()).toBe("1.2");
  });

  it("refuses a record whose cached count exceeds the prompt it is supposed to be part of", () => {
    const broken = rec("i5", { input: 100, cached_input: 200 });
    expect(() => callCostOf(broken, { price: GEMINI, cachedInsideInput: true })).toThrow(/cached_input 200 exceeds usage\.input 100/);
  });
});

describe("computePrint with cachedTokensCountedOnce", () => {
  const CLASS_WEIGHTS = { T1: "0.5", T2: "0.3", T3: "0.2" };
  const threeClasses = (usage: Partial<RunRecord["usage"]>, over: Partial<RunRecord> = {}): RunRecord[] =>
    (["T1", "T2", "T3"] as const).map((cls) => rec(`${cls}-0`, usage, over, cls));
  const input = (models: ModelInput[], cachedOnce: boolean): PrintInput => ({
    version: "SIU-2026a",
    print_id: "p",
    date: "2026-11-22",
    status: "provisional",
    classWeights: CLASS_WEIGHTS,
    models,
    price_snapshot_ref: "s",
    methodology_version: "v0-draft",
    billedCostWhereReported: true,
    ...(cachedOnce ? { cachedTokensCountedOnce: true } : {}),
  });
  const gemini: ModelInput = {
    model_id: "gemini",
    price: GEMINI,
    cachedInsideInput: true,
    records: threeClasses({ input: 1_000_000, cached_input: 430_000 }),
  };
  const claude: ModelInput = {
    model_id: "claude",
    price: GEMINI,
    cachedInsideInput: false,
    records: threeClasses({ input: 570_000, cached_input: 430_000 }),
  };

  it("counts a cached token once for a provider that counts it inside the prompt, and leaves Anthropic's additive count as it is", () => {
    const { body } = computePrint(input([gemini, claude], true));
    expect(body.basket_costs).toEqual([
      { model_id: "gemini", cost_usd: "1.226000" },
      { model_id: "claude", cost_usd: "1.226000" },
    ]);
    // Cost of production is every call priced the same way: 6 calls x 1.226.
    expect(body.cost_of_production_usd).toBe("7.3560");
  });

  it("recomputes a print from before the revision as published", () => {
    const { body } = computePrint(input([gemini, claude], false));
    expect(body.basket_costs).toEqual([
      { model_id: "gemini", cost_usd: "2.086000" },
      { model_id: "claude", cost_usd: "1.226000" },
    ]);
  });

  it("counts a cached token once in a carried-forward row as well", () => {
    const today: ModelInput = { model_id: "gemini", price: GEMINI, cachedInsideInput: true, records: [] };
    const priorDay = threeClasses({ input: 1_000_000, cached_input: 430_000 }, { model_id: "gemini" });
    const result = computePrint({
      ...input([today], true),
      carryForwardHistory: [{ date: "2026-11-21", records: new Map([["gemini", priorDay]]) }],
    });
    expect(result.body.basket_costs).toEqual([{ model_id: "gemini", cost_usd: "1.226000", carried_forward_from: "2026-11-21" }]);
  });

  it("computeCostOfProduction takes the rule as its third argument", () => {
    expect(computeCostOfProduction([gemini], true, true).toString()).toBe("3.678");
    expect(computeCostOfProduction([gemini], true).toString()).toBe("6.258");
  });
});

describe("computePriceCheck counts a cached token once", () => {
  it("does not flag grok-4.6 when its billed figure matches the list price with cached tokens counted once (the 2026-11-21 flag)", () => {
    // grok-4.6 list: $2 in, $6 out, $0.20 cached (illustrative usage). 10,000-token prompt with 6,000 cached, 1,000 output:
    // 4,000 x $2 + 6,000 x $0.20 + 1,000 x $6 = 0.008 + 0.0012 + 0.006 = 0.0152 billed.
    const grok: ModelInput = {
      model_id: "grok-4.6",
      price: { price_in_usd_per_1m: "2", price_out_usd_per_1m: "6", price_cached_in_usd_per_1m: "0.2" },
      cachedInsideInput: true,
      records: [rec("a", { input: 10_000, cached_input: 6_000, output: 1_000 }, { billed_usd: "0.0152" })],
    };
    const check = computePriceCheck([grok], new Map([["grok-4.6", "default"]]));
    expect(check.flagged).toBe(false);
    expect(check.rows[0]).toMatchObject({ listed_usd: "0.0152", gap: "0" });
  });
});
