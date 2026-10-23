/**
 * Derives the output allowances from the recorded answers (D113) and, with `--write`, freezes them in `data/lab/cr/allowances.json`. Reads the private records, calls nothing, spends nothing.
 *
 *   pnpm --filter @touchstone/cr-lab run derive-allowances                print what the rule gives from every snapshot-mode and dry-run answer recorded so far
 *   pnpm --filter @touchstone/cr-lab run derive-allowances -- --write     write the frozen file (refuses to overwrite an existing one: a change is a dated revision, not an edit)
 *   ... -- --mcp [--write]                                                the same rule for MCP mode: the per-turn allowance from every recorded MCP-mode turn, in `allowances-mcp.json` (D120)
 *
 * The file holds token counts per task, never a Blockworks figure.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ALLOWANCES_PATH,
  MCP_ALLOWANCES_PATH,
  PRINT_ALLOWANCE,
  deriveAllowances,
  mcpObservationsOf,
  observationOf,
  type AllowanceFile,
  type Observation,
} from "../runner/allowance.js";
import { FileRecordStore } from "../runner/records.js";
import { TASKS } from "../tasks/instances.js";

const store = new FileRecordStore();
const records = store.windows().flatMap((w) => store.forWindow(w));
const mcp = process.argv.includes("--mcp");
const path = mcp ? MCP_ALLOWANCES_PATH : ALLOWANCES_PATH;
const obs: Observation[] = mcp
  ? records.flatMap(mcpObservationsOf)
  : records.map(observationOf).filter((o): o is Observation => o !== undefined);
const allowance = deriveAllowances(obs);
const observed: AllowanceFile["observed"] = {};
for (const t of TASKS) {
  const mine = obs.filter((o) => o.task === t);
  observed[t] = {
    n: mine.length,
    maxNeed: Math.max(0, ...mine.map((o) => o.need)),
    censored: mine.filter((o) => o.censored).length,
  };
}
console.log(
  `${records.length} recorded answers, ${obs.length} ${mcp ? "MCP-mode turns" : "with a model call to learn from"}`,
);
for (const t of TASKS)
  console.log(
    `  ${t}: n=${observed[t]?.n}, most one call needed ${observed[t]?.maxNeed} (${observed[t]?.censored} cut off, so lower bounds): allowance ${allowance[t]} (the print's was ${PRINT_ALLOWANCE[t]})`,
  );
if (process.argv.includes("--write")) {
  if (existsSync(path)) {
    console.error(`refusing: ${path} exists. A change is a dated revision, not an edit.`);
    process.exit(1);
  }
  const file: AllowanceFile = {
    rule: mcp
      ? "Each task's per-turn output allowance in MCP mode covers almost all observed turns: the most one model call (turn) needed over every recorded MCP-mode session (a turn cut off at the cap counts as at least its cap), times 6/5, rounded up to a multiple of 2,000, never below the print's own allowance. The same for every model. Thinking budgets and the $1 session cap are unchanged. Frozen for the counted windows; a session that never answers counts as zero. Changes only by a dated revision (D120)."
      : "Each task's output allowance covers almost all observed outputs: the most one call needed over every recorded answer (a call cut off again counts as at least its cap), times 6/5, rounded up to a multiple of 2,000, never below the print's own allowance. The same for every model. Frozen for the counted windows (D113).",
    frozenAt: new Date().toISOString().slice(0, 10),
    observed,
    allowance,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`written: ${path}`);
}
