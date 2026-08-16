#!/usr/bin/env -S pnpm exec tsx
// Builds a floor record from a real, already-run measurement session — build1-spec.md §5.
//
// This does NOT rent a GPU, start vLLM, or run the basket for you — see docs/floor-measurement.md
// for that human-run session. This script only takes what the operator measured (which run
// records to grade, a GPU rate snapshot, the wall-clock GPU-seconds, and the utilisation
// assumption) and turns them into a validated, print-consumable floor record. It refuses to
// write one at all if the basket's three quality gates didn't all pass — per CLAUDE.md, if no
// real measurement exists, the floor column stays absent, never invented.
//
// Usage:
//   pnpm run measure-floor -- \
//     --run-id floor-measurement-2026-08-17 \
//     --gpu-rate-snapshot data/registry/gpu-rate-snapshot-2026-08-14T12-17-48.834Z.json \
//     --source vastai \
//     --vllm-version 0.6.3 \
//     --model meta-llama/llama-3.3-70b-instruct \
//     --gpu-seconds 1800 \
//     --utilisation 0.7 \
//     --notes "H100 SXM 80GB, Vast.ai, single instance"

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRecord } from "@datum/sdk";
import {
  checkQualityGatesPassed,
  buildFloorRecord,
  writeFloorRecord,
  readGpuRateSnapshot,
} from "@datum/prices";

interface Flags {
  runId: string;
  gpuRateSnapshot: string;
  source: "akash" | "vastai";
  vllmVersion: string;
  model: string;
  gpuSeconds: string;
  utilisation: string;
  notes?: string;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const runId = get("run-id");
  const gpuRateSnapshot = get("gpu-rate-snapshot");
  const source = get("source");
  const vllmVersion = get("vllm-version");
  const model = get("model");
  const gpuSeconds = get("gpu-seconds");
  const utilisation = get("utilisation") ?? "1.0";
  const notes = get("notes");

  const missing = [
    !runId && "--run-id",
    !gpuRateSnapshot && "--gpu-rate-snapshot",
    !source && "--source",
    !vllmVersion && "--vllm-version",
    !model && "--model",
    !gpuSeconds && "--gpu-seconds",
  ].filter(Boolean);
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.join(", ")}`);
    console.error("See this file's header comment for full usage.");
    process.exit(1);
  }
  if (source !== "akash" && source !== "vastai") {
    console.error(`--source must be "akash" or "vastai", got "${source}".`);
    process.exit(1);
  }

  return {
    runId: runId!,
    gpuRateSnapshot: gpuRateSnapshot!,
    source,
    vllmVersion: vllmVersion!,
    model: model!,
    gpuSeconds: gpuSeconds!,
    utilisation,
    ...(notes !== undefined ? { notes } : {}),
  };
}

/** Reads every run record for `runId` from `data/runs/<runId>/`. A local equivalent of
 * `@datum/print`'s `loadRunRecords`, not a reuse of it — that function resolves paths relative
 * to a package script's own directory two levels under the repo root, which doesn't hold for a
 * root-level script invoked with the repo root itself as `cwd`. */
async function loadRunRecordsFrom(runsDir: string): Promise<RunRecord[]> {
  const files = await readdir(runsDir).catch(() => {
    throw new Error(`No run records directory at ${runsDir}.`);
  });
  const recordFiles = files.filter(
    (f) => f.endsWith(".json") && !f.endsWith(".raw.json") && f !== "reconciliation.json",
  );
  return Promise.all(
    recordFiles.map(
      async (f) => JSON.parse(await readFile(join(runsDir, f), "utf-8")) as RunRecord,
    ),
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const repoRoot = process.cwd();
  const registryDir = resolve(repoRoot, "data/registry");
  const runsDir = resolve(repoRoot, "data/runs", flags.runId);

  const records = await loadRunRecordsFrom(runsDir);
  const qualityGates = checkQualityGatesPassed(records);
  console.log(
    `Quality gates for run "${flags.runId}": T1=${qualityGates.t1} T2=${qualityGates.t2} ` +
      `T3=${qualityGates.t3}`,
  );
  if (!qualityGates.allPassed) {
    console.error(
      "Not all three quality gates passed — refusing to write a floor record. Serve a model " +
        "that passes all three before measuring the floor. The floor column stays absent.",
    );
    process.exit(1);
  }

  const gpuRateSnapshotPath = resolve(repoRoot, flags.gpuRateSnapshot);
  const snapshot = await readGpuRateSnapshot(gpuRateSnapshotPath);

  const timestamp = new Date().toISOString();
  const record = buildFloorRecord(
    {
      runId: flags.runId,
      gpuRateSnapshot: snapshot,
      gpuRateSnapshotRef: flags.gpuRateSnapshot,
      rateSource: flags.source,
      vllmVersion: flags.vllmVersion,
      model: flags.model,
      qualityGates,
      gpuSecondsPerBasket: flags.gpuSeconds,
      utilisationAssumption: flags.utilisation,
      notes: flags.notes,
    },
    timestamp,
  );

  const path = await writeFloorRecord(registryDir, record);
  console.log(`\nWrote floor record -> ${path}`);
  console.log(
    `floor_usd_per_basket = ${record.floor_usd_per_basket} ` +
      `(${flags.gpuSeconds}s / 3600 × $${record.rate_usd_per_hour}/hr ÷ ${flags.utilisation} utilisation)`,
  );
  console.log(
    `\nTo use it: pnpm --filter @datum/print run compute <print-id> ... floor-record=${path}`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
