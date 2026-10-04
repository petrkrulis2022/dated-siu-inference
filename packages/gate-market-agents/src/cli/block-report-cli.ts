/**
 * Prints (and optionally writes) a block report for an EXPLICIT list of runs.
 *
 * A block is a named set, so `--runs` is required and nothing is globbed: reading everything in
 * the runs directory would let a stray debug run or a run from another instrument join a block
 * by being nearby. The builder excludes both anyway, with reasons; this keeps the choice visible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildBlockReport, renderBlockReport, type RunReport } from "./block-report.js";
import { RUNS_ROOT } from "./runs-root.js";

function main(): void {
  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    const v = at === -1 ? undefined : argv[at + 1];
    return v === undefined || v.startsWith("--") ? undefined : v;
  };
  const ids = (arg("--runs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error("--runs <runId,runId,...> is required: a block is an explicit set of runs.");
  }
  const reports = ids.map(
    (id) => JSON.parse(readFileSync(join(RUNS_ROOT, `${id}-report.json`), "utf-8")) as RunReport,
  );
  const block = buildBlockReport(reports);
  for (const line of renderBlockReport(block)) console.log(line);
  const out = arg("--out");
  if (out !== undefined) {
    writeFileSync(out, `${JSON.stringify(block, null, 2)}\n`);
    console.log(`\nfull report written to ${out}`);
  }
}

try {
  main();
} catch (err) {
  console.error(`block-report refused: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
