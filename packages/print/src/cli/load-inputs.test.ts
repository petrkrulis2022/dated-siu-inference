import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot, RunRecord } from "@touchstone/sdk";
import { buildModelInputs, loadCarryForwardHistory, loadRunRecords, printsDir, repoRoot } from "./load-inputs.js";
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

describe("loadRunRecords", () => {
  const RUNS_DIR = resolve(repoRoot(), "data/runs/2026-09-26");
  const SPEND_FILE = join(RUNS_DIR, "spend-by-provider.json");

  afterEach(async () => {
    await rm(SPEND_FILE, { force: true });
  });

  it("never reads a sibling artifact (spend-by-provider.json) as if it were a run record — the real bug found live, 2026-09-28, the first carry-forward print", async () => {
    // A real sibling file, written exactly as publish-unattended.ts writes one: same shape, same
    // path, right next to the real run records already checked in for this date.
    await writeFile(
      SPEND_FILE,
      JSON.stringify({ print_id: "2026-09-26", date: "2026-09-26", spend_usd_by_provider: {} }),
      "utf-8",
    );

    const before = await loadRunRecords("2026-09-26");
    // Confirm the fixture is actually in place before asserting on its absence from the result —
    // a test that can't fail this way proves nothing.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(RUNS_DIR)).toContain("spend-by-provider.json");

    for (const record of before) {
      expect(record).not.toMatchObject({ print_id: "2026-09-26", spend_usd_by_provider: expect.anything() });
    }
    // Every real record still has the shape a RunRecord actually has — the spend file, if it had
    // leaked in, would have parsed but had none of these fields.
    for (const record of before) {
      expect(record.run_id).toBeTruthy();
    }
  });
});

describe("loadCarryForwardHistory", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  // These two use this repo's own real, checked-in data/prints and data/runs (printsDir(),
  // repoRoot()-relative — not parameterizable to a temp dir) rather than a synthetic fixture:
  // since 2026-09-27, loadCarryForwardHistory also loads each source day's real run records
  // (loadDeclaredRunRecords, keyed by that day's own manifest under the real data/runs/<date>/),
  // which a temp prints-only directory has no matching temp runs directory for.
  it("loads real prior days' real run records, most-recent-first, before the given date — never a model excluded that day", async () => {
    const history = await loadCarryForwardHistory(printsDir(), "2026-09-27");
    const dates = history.map((d) => d.date);
    // CARRY_FORWARD_CAP_DAYS (3) + 2 slack days, most-recent-first — see this function's own
    // doc comment for why it casts a slightly wider net than the real cap.
    expect(dates).toEqual(["2026-09-26", "2026-09-25", "2026-09-24", "2026-09-23", "2026-09-22"]);

    // 2026-09-26's own real published print excludes gemini-3.1-pro-preview (a real Google
    // billing lapse — see that print's own correction_notes) — it must never become a
    // carry-forward source from a day it didn't itself qualify on.
    const day26 = history.find((d) => d.date === "2026-09-26")!;
    expect(day26.records.has("gemini-3.1-pro-preview")).toBe(false);
    // A model that DID qualify that day has its own real run records available.
    expect(day26.records.get("claude-sonnet-5")?.length).toBeGreaterThan(0);
  });


  it("returns an empty array rather than throwing when the directory has no prior prints", async () => {
    dir = await mkdtemp(join(tmpdir(), "carry-forward-"));
    const history = await loadCarryForwardHistory(dir, "2026-09-26");
    expect(history).toEqual([]);
  });
});
