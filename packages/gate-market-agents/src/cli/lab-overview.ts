/**
 * The overview of a run, written beside its report: `pnpm run lab-overview [-- --match <text>] [-- --all]`.
 *
 * A new run writes its own (`lab-run`). This is for the runs that came before the report carried its decisions, and for anyone regenerating
 * one: it reads `<run>-report.json`, and where the report has no `decisions` it rebuilds them from the run's recorder folder (`<run>/messages`),
 * if that is still on disk — saying so at the top of the file, so a reconstruction is never read as a record. A scripted walk has no stated
 * reasons and no overview unless `--all` asks for one.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decisionsOf } from "../lab/decisions.js";
import { turnsFromRecorder } from "./recorder-turns.js";
import { renderOverview, type OverviewReport } from "../lab/overview.js";
import { REPO_ROOT } from "./p5-shared.js";

const LAB_RUNS_ROOT = join(REPO_ROOT, "data/lab/runs");

function main(): void {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--match");
  const match = at === -1 ? undefined : argv[at + 1];
  const all = argv.includes("--all");
  const files = readdirSync(LAB_RUNS_ROOT).filter((f) => f.endsWith("-report.json") && (match === undefined || f.includes(match))).sort();
  let wrote = 0;
  for (const f of files) {
    const report = JSON.parse(readFileSync(join(LAB_RUNS_ROOT, f), "utf-8")) as OverviewReport;
    if (report.scripted && !all) continue;
    const runDir = join(LAB_RUNS_ROOT, f.replace(/-report\.json$/, ""));
    let note: string | undefined;
    if (report.decisions === undefined) {
      if (existsSync(join(runDir, "messages"))) {
        report.decisions = decisionsOf(turnsFromRecorder(runDir));
        note = "The decisions and stated reasons below were rebuilt from this run's recorder folder, because the report was written before it carried them. The raw replies there are authoritative.";
      } else {
        note = "This report predates the record of decisions and its recorder folder is not on this machine, so no stated reasons are shown.";
      }
    }
    const path = join(LAB_RUNS_ROOT, f.replace(/-report\.json$/, "-overview.md"));
    writeFileSync(path, `${renderOverview(report, note !== undefined ? { decisionsNote: note } : {})}\n`);
    console.log(`wrote ${path}`);
    wrote += 1;
  }
  console.log(`${wrote} overview(s) written.`);
}

main();
