/**
 * Derives the output allowances from the recorded answers (D113) and, with `--write`, freezes them in `data/lab/cr/allowances.json`. Reads the private records, calls nothing, spends nothing.
 *
 *   pnpm --filter @touchstone/cr-lab run derive-allowances                print what the rule gives from every snapshot-mode and dry-run answer recorded so far
 *   pnpm --filter @touchstone/cr-lab run derive-allowances -- --write     write the frozen file (refuses to overwrite an existing one: a change is a dated revision, not an edit)
 *
 * The file holds token counts per task, never a Blockworks figure.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ALLOWANCES_PATH,
  PRINT_ALLOWANCE,
  deriveAllowances,
  observationOf,
  type AllowanceFile,
  type Observation,
} from "../runner/allowance.js";
import { FileRecordStore } from "../runner/records.js";
import { TASKS } from "../tasks/instances.js";

const store = new FileRecordStore();
const records = store.windows().flatMap((w) => store.forWindow(w));
const obs = records.map(observationOf).filter((o): o is Observation => o !== undefined);
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
console.log(`${records.length} recorded answers, ${obs.length} with a model call to learn from`);
for (const t of TASKS)
  console.log(
    `  ${t}: n=${observed[t]?.n}, most one call needed ${observed[t]?.maxNeed} (${observed[t]?.censored} cut off, so lower bounds): allowance ${allowance[t]} (the print's was ${PRINT_ALLOWANCE[t]})`,
  );
if (process.argv.includes("--write")) {
  if (existsSync(ALLOWANCES_PATH)) {
    console.error(
      `refusing: ${ALLOWANCES_PATH} exists. A change is a dated revision, not an edit.`,
    );
    process.exit(1);
  }
  const file: AllowanceFile = {
    rule: "Each task's output allowance covers almost all observed outputs: the most one call needed over every recorded answer (a call cut off again counts as at least its cap), times 6/5, rounded up to a multiple of 2,000, never below the print's own allowance. The same for every model. Frozen for the counted windows (D113).",
    frozenAt: new Date().toISOString().slice(0, 10),
    observed,
    allowance,
  };
  mkdirSync(dirname(ALLOWANCES_PATH), { recursive: true });
  writeFileSync(ALLOWANCES_PATH, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`written: ${ALLOWANCES_PATH}`);
}
