import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "@datum/sdk";
import {
  checkQualityGatesPassed,
  computeFloorUsdPerBasket,
  buildFloorRecord,
  floorRecordFileName,
  writeFloorRecord,
  readGpuRateSnapshot,
  type FloorRecordInput,
} from "./floor-record.js";
import { writeGpuRateSnapshot } from "./write-gpu-rate-snapshot.js";
import type { GpuRateSnapshot } from "./gpu-rate-snapshot.js";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: "floor-measurement-test",
    model_id: "demo-model",
    task_class: "T1",
    instance_id: "t1-001",
    seed: 1,
    attempt: 1,
    usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
    latency_ms: 500,
    gate_passed: true,
    raw_response_ref: "raw/t1-001.raw.json",
    deviations: [],
    ...overrides,
  };
}

describe("checkQualityGatesPassed", () => {
  it("passes only when all three classes have at least one passing instance", () => {
    const records = [
      record({ task_class: "T1", gate_passed: true }),
      record({ task_class: "T2", gate_passed: true }),
      record({ task_class: "T3", gate_passed: true }),
    ];
    const summary = checkQualityGatesPassed(records);
    expect(summary).toEqual({ t1: true, t2: true, t3: true, allPassed: true });
  });

  it("fails when one class never passed, even if others did", () => {
    const records = [
      record({ task_class: "T1", gate_passed: true }),
      record({ task_class: "T2", gate_passed: false }),
      record({ task_class: "T3", gate_passed: true }),
    ];
    const summary = checkQualityGatesPassed(records);
    expect(summary).toEqual({ t1: true, t2: false, t3: true, allPassed: false });
  });

  it("fails when a class has no records at all", () => {
    const records = [record({ task_class: "T1", gate_passed: true })];
    const summary = checkQualityGatesPassed(records);
    expect(summary).toEqual({ t1: true, t2: false, t3: false, allPassed: false });
  });

  it("a class with at least one passing instance passes, even if other attempts failed", () => {
    const records = [
      record({ task_class: "T1", instance_id: "t1-001", attempt: 1, gate_passed: false }),
      record({ task_class: "T1", instance_id: "t1-001", attempt: 2, gate_passed: true }),
      record({ task_class: "T2", gate_passed: true }),
      record({ task_class: "T3", gate_passed: true }),
    ];
    expect(checkQualityGatesPassed(records).allPassed).toBe(true);
  });
});

describe("computeFloorUsdPerBasket", () => {
  it("matches build1-spec.md §5's formula: (gpu-seconds / 3600) × rate ÷ utilisation", () => {
    // 3600 GPU-seconds (1 hour) at $2/hr, full utilisation -> $2.
    expect(computeFloorUsdPerBasket("3600", "2", "1")).toBe("2");
  });

  it("halves the utilisation assumption doubles the effective floor", () => {
    expect(computeFloorUsdPerBasket("3600", "2", "0.5")).toBe("4");
  });

  it("scales linearly with gpu-seconds", () => {
    expect(computeFloorUsdPerBasket("1800", "2", "1")).toBe("1");
  });
});

describe("buildFloorRecord", () => {
  const snapshot: GpuRateSnapshot = {
    snapshot_id: "test-snapshot",
    timestamp: "2026-08-17T00:00:00.000Z",
    reference_gpu: "NVIDIA H100 SXM 80GB",
    entries: [
      {
        source: "akash",
        gpu_model: "nvidia h100 80Gi SXM5",
        rate_usd_per_hour: "2.71",
        sample_size: 4,
      },
      { source: "vastai", gpu_model: "H100 SXM", rate_usd_per_hour: "1.6", sample_size: 20 },
    ],
  };

  const baseInput: FloorRecordInput = {
    runId: "floor-measurement-2026-08-17",
    gpuRateSnapshot: snapshot,
    gpuRateSnapshotRef: "gpu-rate-snapshot-test.json",
    rateSource: "vastai",
    vllmVersion: "0.6.3",
    model: "meta-llama/llama-3.3-70b-instruct",
    qualityGates: { t1: true, t2: true, t3: true, allPassed: true },
    gpuSecondsPerBasket: "1800",
    utilisationAssumption: "0.7",
  };

  it("refuses to build a record when the quality gates didn't all pass", () => {
    const input = {
      ...baseInput,
      qualityGates: { t1: true, t2: false, t3: true, allPassed: false },
    };
    expect(() => buildFloorRecord(input, "2026-08-17T00:00:00.000Z")).toThrow(
      /not all quality gates passed/,
    );
  });

  it("selects the rate from the requested source, never an average or invented figure", () => {
    const record = buildFloorRecord(baseInput, "2026-08-17T00:00:00.000Z");
    expect(record.rate_usd_per_hour).toBe("1.6");
    expect(record.rate_source).toBe("vastai");
  });

  it("computes floor_usd_per_basket via the same formula computeFloorUsdPerBasket uses", () => {
    const record = buildFloorRecord(baseInput, "2026-08-17T00:00:00.000Z");
    expect(record.floor_usd_per_basket).toBe(computeFloorUsdPerBasket("1800", "1.6", "0.7"));
  });

  it("throws a clear error when the requested rate source isn't in the snapshot", () => {
    const input = {
      ...baseInput,
      rateSource: "akash" as const,
      gpuRateSnapshot: { ...snapshot, entries: [] },
    };
    expect(() => buildFloorRecord(input, "2026-08-17T00:00:00.000Z")).toThrow(/No "akash" entry/);
  });

  it("carries reference_gpu through from the snapshot, not a second freeform input", () => {
    const record = buildFloorRecord(baseInput, "2026-08-17T00:00:00.000Z");
    expect(record.reference_gpu).toBe("NVIDIA H100 SXM 80GB");
  });

  it("omits notes entirely when none is given, rather than an empty string", () => {
    const record = buildFloorRecord(baseInput, "2026-08-17T00:00:00.000Z");
    expect("notes" in record).toBe(false);
  });

  it("carries notes through when given", () => {
    const record = buildFloorRecord(
      { ...baseInput, notes: "measured live" },
      "2026-08-17T00:00:00.000Z",
    );
    expect(record.notes).toBe("measured live");
  });
});

describe("floorRecordFileName", () => {
  it("is filesystem-safe (no colons)", () => {
    const record = buildFloorRecord(
      {
        runId: "r",
        gpuRateSnapshot: {
          snapshot_id: "s",
          timestamp: "t",
          reference_gpu: "g",
          entries: [{ source: "akash", gpu_model: "m", rate_usd_per_hour: "1", sample_size: 1 }],
        },
        gpuRateSnapshotRef: "ref.json",
        rateSource: "akash",
        vllmVersion: "0.6.3",
        model: "m",
        qualityGates: { t1: true, t2: true, t3: true, allPassed: true },
        gpuSecondsPerBasket: "3600",
        utilisationAssumption: "1",
      },
      "2026-08-17T00:00:00.000Z",
    );
    expect(floorRecordFileName(record)).toBe("floor-record-2026-08-17T00-00-00.000Z.json");
  });
});

describe("writeFloorRecord / readGpuRateSnapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "datum-floor-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a record and refuses to overwrite it", async () => {
    const record = buildFloorRecord(
      {
        runId: "r",
        gpuRateSnapshot: {
          snapshot_id: "s",
          timestamp: "t",
          reference_gpu: "g",
          entries: [{ source: "akash", gpu_model: "m", rate_usd_per_hour: "1", sample_size: 1 }],
        },
        gpuRateSnapshotRef: "ref.json",
        rateSource: "akash",
        vllmVersion: "0.6.3",
        model: "m",
        qualityGates: { t1: true, t2: true, t3: true, allPassed: true },
        gpuSecondsPerBasket: "3600",
        utilisationAssumption: "1",
      },
      "2026-08-17T00:00:00.000Z",
    );
    const path = await writeFloorRecord(dir, record);
    await expect(writeFloorRecord(dir, record)).rejects.toThrow(/Refusing to overwrite/);
    const reread = JSON.parse(await readFile(path, "utf-8")) as typeof record;
    expect(reread.floor_usd_per_basket).toBe(record.floor_usd_per_basket);
  });

  it("readGpuRateSnapshot reads back a real written GpuRateSnapshot unchanged", async () => {
    const snapshot: GpuRateSnapshot = {
      snapshot_id: "s",
      timestamp: "2026-08-17T00-00-00.000Z",
      reference_gpu: "NVIDIA H100 SXM 80GB",
      entries: [
        { source: "vastai", gpu_model: "H100 SXM", rate_usd_per_hour: "1.6", sample_size: 20 },
      ],
    };
    const path = await writeGpuRateSnapshot(dir, snapshot);
    const reread = await readGpuRateSnapshot(path);
    expect(reread).toEqual(snapshot);
  });
});
