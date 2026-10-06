/**
 * The lab's result over the reports on disk: `pnpm run lab-report [-- --match <text>]`.
 *
 * Pools only the runs the guard admits (`lab/measure.ts`: a scripted walk, an aborted or contaminated run,
 * one that started from a partial pool or left it short cannot be counted), lists every exclusion with its
 * reason, and applies the draft decision rule to the pool. The rule is a DRAFT until the user approves it
 * (plan §3); this prints its verdict under that rule and says so.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { measureRun, pool, renderPooled, type MeasureReport } from "../lab/measure.js";
import { REPO_ROOT } from "./p5-shared.js";

const LAB_RUNS_ROOT = join(REPO_ROOT, "data/lab/runs");

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--match");
  const match = at === -1 ? undefined : argv[at + 1];
  const files = readdirSync(LAB_RUNS_ROOT)
    .filter((f) => f.endsWith("-report.json") && (match === undefined || f.includes(match)))
    .sort();
  const reports = files.map((f) => JSON.parse(readFileSync(join(LAB_RUNS_ROOT, f), "utf-8")) as MeasureReport);
  console.log(`${reports.length} report(s) in ${LAB_RUNS_ROOT}${match !== undefined ? ` matching "${match}"` : ""}.\n`);

  const pooled = pool(reports);
  console.log(renderPooled(pooled));
  console.log("  (the decision rule is a DRAFT until approved; this is its verdict, not a registered result)\n");

  console.log("PER RUN");
  for (const r of reports) {
    const m = measureRun(r);
    console.log(
      `  ${m.runId}${m.countable ? "" : "  [NOT COUNTED]"}: opportunities ${m.opportunities}, reused ${m.reuse}; ` +
        `routes ${JSON.stringify(m.paymentsByRoute)}; not-wholly-dollar share ${m.fsiuShareOfPayments}; ` +
        `mints/job ${m.mintsPerJob}; needs met ${m.jobsTransacted}; cost $${m.costUsd}`,
    );
  }
}

main();
