import { describe, expect, it } from "vitest";
import type { Print, PriceSnapshot, RunRecord } from "@touchstone/sdk";
import { getQuoteTool } from "./get-quote.js";

function fixturePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-14",
    date: "2026-08-14",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.0019",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.10", spread_to_index: "0", siu_per_usd: "10" },
    ],
    sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "0.06",
    price_snapshot_ref: "snap-1.json",
    methodology_version: "v0-draft",
    signature: `0x${"ab".repeat(64)}`,
    public_key: `0x${"cd".repeat(33)}`,
    ...overrides,
  } as Print;
}

const snapshot: PriceSnapshot = {
  snapshot_id: "snap-1",
  timestamp: "2026-08-14T00:00:00Z",
  source: "openrouter",
  entries: [{ model_id: "A", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
};

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "r1",
    model_id: "A",
    task_class: "T1",
    instance_id: "i1",
    seed: 1,
    attempt: 1,
    usage: { input: 1000, output: 500, cached_input: 0, reasoning: 0 },
    latency_ms: 100,
    gate_passed: true,
    raw_response_ref: "raw/r1",
    deviations: [],
    ...overrides,
  };
}

describe("getQuoteTool", () => {
  it("derives siu_per_call from a fresh class-cost computation divided by usd_per_siu", () => {
    const result = getQuoteTool({ task_class: "T1", model: "A" }, fixturePrint(), snapshot, [
      runRecord(),
    ]);
    // cost = 1000/1e6*1.00 + 500/1e6*2.00 = 0.001 + 0.001 = 0.002
    // siu_per_call = 0.002 / 0.10 = 0.02
    expect(result.siu_per_call).toBe("0.02");
    expect(result.usd_per_call).toBe("0.002");
    expect(result.usd_per_siu).toBe("0.10");
    expect(result.index_version).toBe("SIU-2026a");
    expect(result.print_id).toBe("2026-08-14");
    expect(result.print_hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("keeps usd_per_call and siu_per_call × usd_per_siu in agreement — an agent should see the same call priced both ways", () => {
    const result = getQuoteTool({ task_class: "T1", model: "A" }, fixturePrint(), snapshot, [
      runRecord(),
    ]);
    const recomputed = Number(result.siu_per_call) * Number(result.usd_per_siu);
    expect(recomputed).toBeCloseTo(Number(result.usd_per_call), 10);
  });

  it("rejects an unknown task_class", () => {
    expect(() =>
      getQuoteTool({ task_class: "T9", model: "A" }, fixturePrint(), snapshot, []),
    ).toThrow(/Unknown task_class/);
  });

  it("throws honestly when the model has no published exchange rate", () => {
    expect(() =>
      getQuoteTool({ task_class: "T1", model: "Z" }, fixturePrint(), snapshot, []),
    ).toThrow(/no published exchange rate/);
  });

  it("throws honestly when there are no run records for this class (data/runs is empty)", () => {
    expect(() =>
      getQuoteTool({ task_class: "T1", model: "A" }, fixturePrint(), snapshot, []),
    ).toThrow(/No priced T1 run records/);
  });

  it("filters run records to the requested task_class only", () => {
    const records = [
      runRecord({
        task_class: "T1",
        usage: { input: 1000, output: 500, cached_input: 0, reasoning: 0 },
      }),
      runRecord({
        task_class: "T2",
        instance_id: "i2",
        usage: { input: 50000, output: 900, cached_input: 0, reasoning: 0 },
      }),
    ];
    const result = getQuoteTool(
      { task_class: "T1", model: "A" },
      fixturePrint(),
      snapshot,
      records,
    );
    expect(result.siu_per_call).toBe("0.02"); // same as the T1-only test above
  });
});
