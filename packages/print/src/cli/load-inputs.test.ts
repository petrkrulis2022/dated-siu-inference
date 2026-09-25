import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot, RunRecord } from "@touchstone/sdk";
import { buildModelInputs } from "./load-inputs.js";
import { computePrint } from "../compute/index.js";

const REGISTRY: ModelRegistryEntry[] = [
  { id: "healthy-model", provider: "openrouter", endpoint: "x", model_string: "x", tier: "open-weight-hosted", open_weights: true, host: "h" },
  { id: "zero-record-model", provider: "anthropic", endpoint: "x", model_string: "x", tier: "frontier", open_weights: false, host: "anthropic" },
];

const SNAPSHOT: PriceSnapshot = {
  snapshot_id: "s1",
  timestamp: "2026-09-08T00:00:00Z",
  source: "merged",
  entries: [
    { model_id: "healthy-model", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" },
    { model_id: "zero-record-model", price_in_usd_per_1m: "3.00", price_out_usd_per_1m: "4.00" },
  ],
};

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "r1",
    model_id: "healthy-model",
    task_class: "T1",
    instance_id: "i1",
    seed: 1,
    attempt: 1,
    usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
    latency_ms: 500,
    gate_passed: true,
    raw_response_ref: "ref",
    deviations: [],
    ...overrides,
  };
}

describe("buildModelInputs", () => {
  it("includes a registry model with zero run records, with an empty records array, rather than dropping it", () => {
    const { models, unpriced } = buildModelInputs(REGISTRY, SNAPSHOT, [runRecord()]);
    expect(unpriced).toEqual([]);
    const zeroRecordEntry = models.find((m) => m.model_id === "zero-record-model");
    expect(zeroRecordEntry).toBeDefined();
    expect(zeroRecordEntry?.records).toEqual([]);
  });

  it("carries a snapshot entry's price_cached_in_usd_per_1m through into ModelInput.price", () => {
    // Found live, 2026-09-25: this field was added to the schema, the cost formula, and
    // litellm.ts's snapshot sourcing (29d4be2, 2026-09-13), but never copied through here — so
    // every real print since has priced cached_input at zero for every model, even one with a
    // genuinely published cached rate. Regression test for that omission, not for a hypothetical.
    const snapshotWithCache: PriceSnapshot = {
      snapshot_id: "s1",
      timestamp: "2026-09-08T00:00:00Z",
      source: "merged",
      entries: [
        {
          model_id: "healthy-model",
          price_in_usd_per_1m: "1.00",
          price_out_usd_per_1m: "2.00",
          price_cached_in_usd_per_1m: "0.20",
        },
      ],
    };
    const { models } = buildModelInputs(
      [REGISTRY[0]],
      snapshotWithCache,
      [runRecord()],
    );
    expect(models[0].price.price_cached_in_usd_per_1m).toBe("0.20");
  });

  it("end to end: a real cached rate actually changes the published cost_usd, not just the intermediate ModelInput", () => {
    // The regression this bug needed and never got: load-inputs.test.ts's own prior coverage
    // (and litellm.ts's/build-snapshot.ts's own tests) checked only that the pricing FUNCTION
    // handles cached_input correctly in isolation — never that a real snapshot's cached rate
    // survives the real buildModelInputs -> computePrint path and actually moves the number a
    // print publishes. That gap is exactly how this stayed dead code for twelve days (2026-09-13
    // through 2026-09-25) with every existing test green. Two runs, identical except one has a
    // real cached rate and real cached usage — the published cost_usd must differ, by exactly the
    // cached contribution the cost formula defines (docs/methodology.md's cost-of-production
    // section), not merely be present on some intermediate object nothing downstream reads.
    const registry: ModelRegistryEntry[] = [REGISTRY[0]];
    const records = [
      runRecord({ task_class: "T1" }),
      runRecord({ task_class: "T2", instance_id: "i2" }),
      runRecord({ task_class: "T3", instance_id: "i3" }),
    ];
    const classWeights = { T1: "0.50", T2: "0.30", T3: "0.20" };

    const snapshotNoCache: PriceSnapshot = {
      ...SNAPSHOT,
      entries: [{ model_id: "healthy-model", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
    };
    const { models: modelsNoCache } = buildModelInputs(registry, snapshotNoCache, records);
    const { body: bodyNoCache } = computePrint({
      version: "SIU-2026a", print_id: "p1", date: "2026-09-25", status: "provisional",
      classWeights, models: modelsNoCache, price_snapshot_ref: "snap.json", methodology_version: "v0-draft",
    });
    const costNoCache = bodyNoCache.basket_costs.find((b) => b.model_id === "healthy-model")?.cost_usd;
    expect(costNoCache).toBeDefined();

    const recordsWithCache = records.map((r) => ({ ...r, usage: { ...r.usage, cached_input: 1000 } }));
    const snapshotWithCache: PriceSnapshot = {
      ...SNAPSHOT,
      entries: [
        {
          model_id: "healthy-model",
          price_in_usd_per_1m: "1.00",
          price_out_usd_per_1m: "2.00",
          price_cached_in_usd_per_1m: "0.50",
        },
      ],
    };
    const { models: modelsWithCache } = buildModelInputs(registry, snapshotWithCache, recordsWithCache);
    const { body: bodyWithCache } = computePrint({
      version: "SIU-2026a", print_id: "p1", date: "2026-09-25", status: "provisional",
      classWeights, models: modelsWithCache, price_snapshot_ref: "snap.json", methodology_version: "v0-draft",
    });
    const costWithCache = bodyWithCache.basket_costs.find((b) => b.model_id === "healthy-model")?.cost_usd;
    expect(costWithCache).toBeDefined();

    expect(Number(costWithCache)).toBeGreaterThan(Number(costNoCache));
  });

  it("still reports a genuinely unpriced model, zero-record or not", () => {
    const registryWithUnpriced: ModelRegistryEntry[] = [
      ...REGISTRY,
      { id: "no-price-model", provider: "openrouter", endpoint: "x", model_string: "x", tier: "open-weight-hosted", open_weights: true, host: "h" },
    ];
    const { unpriced } = buildModelInputs(registryWithUnpriced, SNAPSHOT, [runRecord()]);
    expect(unpriced).toEqual(["no-price-model"]);
  });

  it("end to end: a zero-run-record model produces an explicit excluded_reason row in the published print, never a silent gap — the actual bug this fixes", () => {
    const { models } = buildModelInputs(REGISTRY, SNAPSHOT, [
      runRecord({ task_class: "T1" }),
      runRecord({ task_class: "T2", instance_id: "i2" }),
      runRecord({ task_class: "T3", instance_id: "i3" }),
    ]);

    const { body } = computePrint({
      version: "SIU-2026a",
      print_id: "2026-09-08",
      date: "2026-09-08",
      status: "provisional",
      classWeights: { T1: "0.50", T2: "0.30", T3: "0.20" },
      models,
      price_snapshot_ref: "snap.json",
      methodology_version: "v0-draft",
    });

    const gapRow = body.basket_costs.find((b) => b.model_id === "zero-record-model");
    expect(gapRow).toBeDefined();
    expect(gapRow?.cost_usd).toBeUndefined();
    expect(gapRow?.excluded_reason).toContain("no run records for this class");

    const gapRateRow = body.exchange_rate_table.find((r) => r.model_id === "zero-record-model");
    expect(gapRateRow).toBeDefined();
    expect(gapRateRow?.excluded_reason).toBeDefined();

    // The healthy model still qualifies normally — this fix doesn't touch models with real data.
    const healthyRow = body.basket_costs.find((b) => b.model_id === "healthy-model");
    expect(healthyRow?.cost_usd).toBeDefined();
  });
});
