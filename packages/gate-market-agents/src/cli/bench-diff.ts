import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { computeBenchDiff, formatBenchDiffReport } from "../run-recorder/bench-diff.js";
import { RUNS_ROOT } from "./runs-root.js";

function loadRun(runId: string): { manifest: unknown; metrics: unknown } {
  const dir = join(RUNS_ROOT, runId);
  const manifest = parse(readFileSync(join(dir, "manifest.yaml"), "utf-8"));
  const metrics = JSON.parse(readFileSync(join(dir, "metrics.json"), "utf-8"));
  return { manifest, metrics };
}

function main(): void {
  const [runIdA, runIdB] = process.argv.slice(2);
  if (!runIdA || !runIdB) {
    console.error("Usage: bench-diff <run_id_a> <run_id_b>");
    console.error(`Run ids are read from ${RUNS_ROOT}/<run_id>/.`);
    process.exit(1);
  }

  const a = loadRun(runIdA);
  const b = loadRun(runIdB);
  const report = computeBenchDiff(a.manifest, b.manifest, a.metrics, b.metrics);
  console.log(formatBenchDiffReport(report, runIdA, runIdB));
}

main();
