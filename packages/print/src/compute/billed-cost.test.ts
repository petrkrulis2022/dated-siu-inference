import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computeClassCost, callCostOf, type ModelPrice } from "./class-cost.js";
import { computeCostOfProduction } from "./cost-of-production.js";
import { computePrint, type ModelInput, type PrintInput } from "./index.js";

// rules-2026-11-20: a constituent's price is what it was billed, read from each response; a list price is a cross-check. Two live cases drive
// these tests. qwen-2.5-72b-instruct: snapshot priced at DeepInfra's flex tier ($0.288/$0.32), every call billed at the standard $0.36/$0.40.
// mistral-small-3.2-24b-deepinfra: priced at the standard $0.075/$0.20, some calls served and billed on the priority tier ($0.1125/$0.30).

const FLEX: ModelPrice = { price_in_usd_per_1m: "0.288", price_out_usd_per_1m: "0.32" };
const STANDARD: ModelPrice = { price_in_usd_per_1m: "0.075", price_out_usd_per_1m: "0.2" };
const PRIORITY: ModelPrice = { price_in_usd_per_1m: "0.1125", price_out_usd_per_1m: "0.3" };

function rec(
  instanceId: string,
  over: Partial<RunRecord> = {},
  taskClass: RunRecord["task_class"] = "T1",
): RunRecord {
  return {
    run_id: `${instanceId}-1`,
    model_id: "m",
    task_class: taskClass,
    instance_id: instanceId,
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

describe("callCostOf (rules-2026-11-20)", () => {
  it("prices a call at what its response says was billed, not at the snapshot's list price", () => {
    const call = rec("i0", { service_tier: "default", billed_usd: "0.76" });
    expect(callCostOf(call, { price: FLEX, billed: true }).toString()).toBe("0.76");
  });

  it("ignores the billed figure under an earlier rule, so a historical print recomputes as published", () => {
    const call = rec("i0", { service_tier: "default", billed_usd: "0.76" });
    expect(callCostOf(call, { price: FLEX }).toString()).toBe("0.608");
  });

  it("prices a call with no billed figure at the list price of the tier its response reports", () => {
    const tierPrices = { priority: PRIORITY };
    expect(callCostOf(rec("i0", { service_tier: "priority" }), { price: STANDARD, tierPrices, billed: true }).toString()).toBe("0.4125");
    expect(callCostOf(rec("i1", { service_tier: "default" }), { price: STANDARD, tierPrices, billed: true }).toString()).toBe("0.275");
    expect(callCostOf(rec("i2", { service_tier: null }), { price: STANDARD, tierPrices, billed: true }).toString()).toBe("0.275");
    expect(callCostOf(rec("i3"), { price: STANDARD, tierPrices, billed: true }).toString()).toBe("0.275");
  });

  it("scales a billed call by a sensitivity variant's ratio, so the variant moves from the billed level", () => {
    const call = rec("i0", { service_tier: "default", billed_usd: "0.76" });
    // List at the standard tier: 0.36 + 0.40 = 0.76; halving both prices halves it; the billed call scales the same way.
    const pricing = { price: { price_in_usd_per_1m: "0.36", price_out_usd_per_1m: "0.4" }, billed: true };
    const half = { inputMultiplier: "0.5", outputMultiplier: "0.5" };
    expect(callCostOf(call, { ...pricing, adjustment: half }).toString()).toBe("0.38");
  });
});

describe("computeClassCost with call pricing", () => {
  it("averages billed costs over passing instances, summing attempts to the first pass as before", () => {
    const records = [
      rec("i0", { billed_usd: "0.4125", service_tier: "priority" }),
      rec("i1", { billed_usd: "0.275", service_tier: "default" }),
    ];
    expect(computeClassCost(records, { price: STANDARD, billed: true }).cost?.toString()).toBe("0.34375");
    expect(computeClassCost(records, STANDARD).cost?.toString()).toBe("0.275");
  });
});

describe("computeCostOfProduction with the billed rule", () => {
  it("sums what every call was billed where the response says, and list prices elsewhere", () => {
    const models: ModelInput[] = [
      { model_id: "a", price: STANDARD, records: [rec("i0", { billed_usd: "0.4125" }), rec("i1")] },
    ];
    expect(computeCostOfProduction(models, true).toString()).toBe("0.6875");
    expect(computeCostOfProduction(models).toString()).toBe("0.55");
  });
});

describe("computePrint with billedCostWhereReported", () => {
  const CLASS_WEIGHTS = { T1: "0.5", T2: "0.3", T3: "0.2" };
  function threeClasses(over: (cls: RunRecord["task_class"]) => Partial<RunRecord>): RunRecord[] {
    return (["T1", "T2", "T3"] as const).map((cls) => rec(`${cls}-0`, over(cls), cls));
  }
  function input(models: ModelInput[], billed: boolean): PrintInput {
    return {
      version: "SIU-2026a",
      print_id: "p",
      date: "2026-11-21",
      status: "provisional",
      classWeights: CLASS_WEIGHTS,
      models,
      price_snapshot_ref: "s",
      methodology_version: "v0-draft",
      ...(billed ? { billedCostWhereReported: true } : {}),
    };
  }

  it("takes each constituent's basket cost from its billed calls, priority-tier calls included", () => {
    const mistral: ModelInput = {
      model_id: "mistral",
      price: STANDARD,
      tierPrices: { priority: PRIORITY },
      records: threeClasses((cls) =>
        cls === "T2" ? { service_tier: "priority", billed_usd: "0.4125" } : { service_tier: "default", billed_usd: "0.275" },
      ),
    };
    // Billed: 0.5*0.275 + 0.3*0.4125 + 0.2*0.275 = 0.31625.
    expect(computePrint(input([mistral], true)).body.basket_costs).toEqual([{ model_id: "mistral", cost_usd: "0.316250" }]);
    // A print computed before rules-2026-11-20 recomputes as published: its snapshot lists no tiers, so every call is priced at the declared
    // endpoint's list price, 0.275 in every class — the 10-20% understatement the 2026-11-18 admission note disclosed.
    const asPublished = { ...mistral, tierPrices: undefined };
    expect(computePrint(input([asPublished], false)).body.basket_costs).toEqual([{ model_id: "mistral", cost_usd: "0.275000" }]);
  });

  it("reprices a carried-forward row at today's list price, never at the billed figure of the day it was measured", () => {
    const today: ModelInput = { model_id: "q", price: { price_in_usd_per_1m: "0.36", price_out_usd_per_1m: "0.4" }, records: [] };
    const priorDay = threeClasses(() => ({ model_id: "q", service_tier: "default", billed_usd: "9" }));
    const result = computePrint({
      ...input([today], true),
      carryForwardHistory: [{ date: "2026-11-20", records: new Map([["q", priorDay]]) }],
    });
    expect(result.body.basket_costs).toEqual([{ model_id: "q", cost_usd: "0.760000", carried_forward_from: "2026-11-20" }]);
  });
});
