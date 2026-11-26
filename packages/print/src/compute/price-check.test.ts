import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computePriceCheck } from "./price-check.js";
import type { ModelInput } from "./index.js";

// rules-2026-11-20's daily reconciliation: what each constituent was billed, from its responses, against the same calls at the list price of the
// tier each response reports. A gap over 1% is flagged.

function rec(id: string, over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: id,
    model_id: "m",
    task_class: "T1",
    instance_id: id,
    seed: 1,
    attempt: 1,
    usage: { input: 1_000_000, output: 1_000_000, cached_input: 0, reasoning: 0 },
    latency_ms: 1,
    gate_passed: true,
    raw_response_ref: "r.json",
    deviations: [],
    ...over,
  };
}

const STANDARD = { price_in_usd_per_1m: "0.075", price_out_usd_per_1m: "0.2" };
const PRIORITY = { price_in_usd_per_1m: "0.1125", price_out_usd_per_1m: "0.3" };

describe("computePriceCheck", () => {
  it("flags a constituent whose list price misses what it was billed by more than 1% (the qwen flex-tier case)", () => {
    const qwen: ModelInput = {
      model_id: "qwen-2.5-72b-instruct",
      price: { price_in_usd_per_1m: "0.288", price_out_usd_per_1m: "0.32" },
      records: [rec("a", { service_tier: "default", billed_usd: "0.76" }), rec("b", { service_tier: "default", billed_usd: "0.76" })],
    };
    const check = computePriceCheck([qwen], new Map([["qwen-2.5-72b-instruct", "default"]]));
    expect(check.flagged).toBe(true);
    expect(check.rows[0]).toMatchObject({
      model_id: "qwen-2.5-72b-instruct",
      calls: 2,
      calls_billed: 2,
      billed_usd: "1.52",
      listed_usd: "1.216",
      gap: "0.25",
      tiers_served: { default: 2 },
      flagged: true,
    });
    expect(check.rows[0]?.reasons.join(" ")).toMatch(/billed 25(\.0+)?% above the list price/);
  });

  it("does not flag priority-tier calls priced at their own tier, and reports them as served off the declared tier", () => {
    const mistral: ModelInput = {
      model_id: "mistral-small-3.2-24b-deepinfra",
      price: STANDARD,
      tierPrices: { priority: PRIORITY },
      records: [
        rec("a", { service_tier: "default", billed_usd: "0.275" }),
        rec("b", { service_tier: "priority", billed_usd: "0.4125" }),
      ],
    };
    const check = computePriceCheck([mistral], new Map([["mistral-small-3.2-24b-deepinfra", "default"]]));
    expect(check.flagged).toBe(false);
    expect(check.rows[0]).toMatchObject({
      billed_usd: "0.6875",
      listed_usd: "0.6875",
      gap: "0",
      tiers_served: { default: 1, priority: 1 },
      calls_off_declared_tier: 1,
      flagged: false,
    });
  });

  it("flags a call served on a tier the snapshot has no list price for", () => {
    const m: ModelInput = { model_id: "m", price: STANDARD, records: [rec("a", { service_tier: "priority", billed_usd: "0.4125" })] };
    const check = computePriceCheck([m], new Map([["m", "default"]]));
    expect(check.flagged).toBe(true);
    expect(check.rows[0]?.reasons.join(" ")).toMatch(/tier "priority" has no list price/);
  });

  it("flags calls with no billed figure from a constituent whose responses otherwise report one", () => {
    const m: ModelInput = {
      model_id: "m",
      price: STANDARD,
      records: [rec("a", { service_tier: "default", billed_usd: "0.275" }), rec("b", { service_tier: "default" })],
    };
    const check = computePriceCheck([m], new Map([["m", "default"]]));
    expect(check.flagged).toBe(true);
    expect(check.rows[0]).toMatchObject({ calls: 2, calls_billed: 1 });
    expect(check.rows[0]?.reasons.join(" ")).toMatch(/1 of 2 calls report no billed figure/);
  });

  it("reports a constituent whose responses carry no billed figure without flagging it: its invoice reconciles it", () => {
    const claude: ModelInput = { model_id: "claude-sonnet-5", price: STANDARD, records: [rec("a", { service_tier: "standard" })] };
    const check = computePriceCheck([claude], new Map([["claude-sonnet-5", "standard"]]));
    expect(check.flagged).toBe(false);
    expect(check.rows[0]).toMatchObject({ model_id: "claude-sonnet-5", calls: 1, calls_billed: 0, billed_usd: null, flagged: false });
  });

  it("treats a gap of exactly 1% as within tolerance", () => {
    const m: ModelInput = { model_id: "m", price: STANDARD, records: [rec("a", { service_tier: "default", billed_usd: "0.27775" })] };
    expect(computePriceCheck([m], new Map([["m", "default"]])).flagged).toBe(false);
  });
});
