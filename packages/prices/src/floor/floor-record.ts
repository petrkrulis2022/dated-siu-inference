import { readFile, access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { D, type RunRecord } from "@touchstone/sdk";
import type { GpuRateSnapshot } from "./gpu-rate-snapshot.js";

/**
 * "Cost-floor column" — build1-spec.md §5: GPU-seconds per basket, measured on a rented
 * reference configuration served with vLLM, multiplied by a rental rate and divided by an
 * assumed utilisation. This file is the pure, testable half of that (arithmetic and record
 * shape); `scripts/measure-floor.ts` is the thin CLI wrapper an operator actually runs.
 */

export async function readGpuRateSnapshot(path: string): Promise<GpuRateSnapshot> {
  return JSON.parse(await readFile(path, "utf-8")) as GpuRateSnapshot;
}

export interface QualityGateSummary {
  t1: boolean;
  t2: boolean;
  t3: boolean;
  allPassed: boolean;
}

/**
 * A class "passes" iff at least one run record for it has `gate_passed: true` — the same
 * semantics `@touchstone/print`'s `computeClassCost` already uses ("if NO instance passed, the class
 * is undefined"). Reuses the harness's own recorded grading rather than re-invoking
 * `@touchstone/basket`'s graders: `gate_passed` was already set by the real basket run this record
 * describes, and re-grading here would be a second, divergence-prone copy of that judgment.
 */
export function checkQualityGatesPassed(records: RunRecord[]): QualityGateSummary {
  const passedClasses = new Set(records.filter((r) => r.gate_passed).map((r) => r.task_class));
  const t1 = passedClasses.has("T1");
  const t2 = passedClasses.has("T2");
  const t3 = passedClasses.has("T3");
  return { t1, t2, t3, allPassed: t1 && t2 && t3 };
}

/**
 * build1-spec.md §5's exact formula: GPU-seconds per basket, multiplied by a rental rate,
 * divided by an assumed utilisation. Left at full computed precision — no rounding here, per
 * CLAUDE.md's "rounding applied at publication only, per stated rules."
 */
export function computeFloorUsdPerBasket(
  gpuSecondsPerBasket: string,
  rateUsdPerHour: string,
  utilisationAssumption: string,
): string {
  const SECONDS_PER_HOUR = new D(3600);
  return new D(gpuSecondsPerBasket)
    .dividedBy(SECONDS_PER_HOUR)
    .times(rateUsdPerHour)
    .dividedBy(utilisationAssumption)
    .toString();
}

export interface FloorRecordInput {
  runId: string;
  gpuRateSnapshot: GpuRateSnapshot;
  gpuRateSnapshotRef: string;
  rateSource: "akash" | "vastai";
  vllmVersion: string;
  model: string;
  qualityGates: QualityGateSummary;
  gpuSecondsPerBasket: string;
  utilisationAssumption: string;
  notes?: string;
}

export interface FloorRecord {
  record_id: string;
  timestamp: string;
  run_id: string;
  reference_gpu: string;
  gpu_rate_snapshot_ref: string;
  rate_source: "akash" | "vastai";
  rate_usd_per_hour: string;
  vllm_version: string;
  model: string;
  quality_gates: { t1: boolean; t2: boolean; t3: boolean };
  gpu_seconds_per_basket: string;
  utilisation_assumption: string;
  floor_usd_per_basket: string;
  notes?: string;
}

/** Builds the full record. Refuses to build one at all when the quality gates didn't all pass —
 * mirrors CLAUDE.md's "if no measurement exists, the column stays absent": a floor measured
 * against a model that failed a gate is not a measurement worth publishing. */
export function buildFloorRecord(input: FloorRecordInput, timestamp: string): FloorRecord {
  if (!input.qualityGates.allPassed) {
    throw new Error(
      `Refusing to build a floor record: not all quality gates passed ` +
        `(t1=${input.qualityGates.t1}, t2=${input.qualityGates.t2}, t3=${input.qualityGates.t3}). ` +
        `Serve a model that passes all three before measuring the floor.`,
    );
  }

  const rateEntry = input.gpuRateSnapshot.entries.find((e) => e.source === input.rateSource);
  if (!rateEntry) {
    throw new Error(
      `No "${input.rateSource}" entry in the supplied GPU rate snapshot ` +
        `(${input.gpuRateSnapshotRef}) — has entries for: ` +
        `${input.gpuRateSnapshot.entries.map((e) => e.source).join(", ") || "(none)"}.`,
    );
  }

  const floorUsdPerBasket = computeFloorUsdPerBasket(
    input.gpuSecondsPerBasket,
    rateEntry.rate_usd_per_hour,
    input.utilisationAssumption,
  );

  return {
    record_id: `floor-record-${timestamp}`,
    timestamp,
    run_id: input.runId,
    reference_gpu: input.gpuRateSnapshot.reference_gpu,
    gpu_rate_snapshot_ref: input.gpuRateSnapshotRef,
    rate_source: input.rateSource,
    rate_usd_per_hour: rateEntry.rate_usd_per_hour,
    vllm_version: input.vllmVersion,
    model: input.model,
    quality_gates: {
      t1: input.qualityGates.t1,
      t2: input.qualityGates.t2,
      t3: input.qualityGates.t3,
    },
    gpu_seconds_per_basket: input.gpuSecondsPerBasket,
    utilisation_assumption: input.utilisationAssumption,
    floor_usd_per_basket: floorUsdPerBasket,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
  };
}

export function floorRecordFileName(record: FloorRecord): string {
  const safeTimestamp = record.timestamp.replace(/:/g, "-");
  return `floor-record-${safeTimestamp}.json`;
}

/** Same immutability rule as price/GPU-rate snapshots: never overwrite an existing file — a
 * floor record is evidence of one real measurement session, not a value to be silently replaced. */
export async function writeFloorRecord(registryDir: string, record: FloorRecord): Promise<string> {
  await mkdir(registryDir, { recursive: true });
  const filePath = join(registryDir, floorRecordFileName(record));

  const alreadyExists = await access(filePath)
    .then(() => true)
    .catch(() => false);
  if (alreadyExists) {
    throw new Error(`Refusing to overwrite existing immutable floor record: ${filePath}`);
  }

  await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  return filePath;
}
