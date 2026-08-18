import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computeCostOfProduction } from "./cost-of-production.js";
import type { ModelInput } from "./index.js";

function rec(input: number, output: number, gatePassed: boolean): RunRecord {
  return {
    run_id: Math.random().toString(),
    model_id: "m",
    task_class: "T1",
    instance_id: "T1-00",
    seed: 1,
    attempt: 1,
    usage: { input, output, cached_input: 0, reasoning: 0 },
    latency_ms: 1,
    gate_passed: gatePassed,
    raw_response_ref: "r.json",
    deviations: [],
  };
}

describe("computeCostOfProduction", () => {
  it("sums cost across every record for every model", () => {
    const models: ModelInput[] = [
      {
        model_id: "A",
        price: { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
        records: [rec(1_000_000, 0, true)], // costs exactly $1.00
      },
      {
        model_id: "B",
        price: { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
        records: [rec(0, 1_000_000, true)], // costs exactly $2.00
      },
    ];
    expect(computeCostOfProduction(models).toString()).toBe("3");
  });

  it("counts every retry attempt, not just the one that passed", () => {
    // Two failed attempts plus one passing attempt, each costing $1.00 -> $3.00 total spend,
    // even though the index's own class-cost logic would only count up to first pass.
    const models: ModelInput[] = [
      {
        model_id: "A",
        price: { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "0" },
        records: [rec(1_000_000, 0, false), rec(1_000_000, 0, false), rec(1_000_000, 0, true)],
      },
    ];
    expect(computeCostOfProduction(models).toString()).toBe("3");
  });

  it("includes a model that failed every attempt and never qualified for the index", () => {
    // A model excluded from the reference set still cost real money to measure.
    const models: ModelInput[] = [
      {
        model_id: "D",
        price: { price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "0" },
        records: [rec(1_000_000, 0, false), rec(1_000_000, 0, false), rec(1_000_000, 0, false)],
      },
    ];
    expect(computeCostOfProduction(models).toString()).toBe("3");
  });

  it("is zero for an empty model list", () => {
    expect(computeCostOfProduction([]).toString()).toBe("0");
  });
});
