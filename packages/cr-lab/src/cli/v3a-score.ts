/**
 * `pnpm --filter @touchstone/cr-lab run v3a-score -- --params <v3a params> --logs <log.jsonl>[,<log.jsonl>...] [--codes-a <path> --codes-b <path> [--hand <path>]] --out <path>`
 *
 * Scores v3a runs (docs/experiment-3a-design.md; `economy/v3a-measures.ts`): each run's validity gates first (a run that fails any is reported invalid and left out of the
 * scoring, never rerun quietly), then every measure pooled across the valid runs of each arm, with arm B's extra measures and arm A's kill rule. The account measure needs
 * the two coders' labels (`v3a-coding`); without them it reports n/a, which never counts as a kill signal. `--out` never overwrites an existing file.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { LogEntry } from "../economy/log.js";
import { loadParams } from "../economy/params.js";
import { loadV3aPassRates } from "../economy/runner.js";
import type { UnitLabel } from "../economy/v3a-coding.js";
import { checkGates, gatesPass } from "../economy/v3a-gates.js";
import { renderArmScore, runMeta, scoreArm, type Codings, type V3aRunLog } from "../economy/v3a-measures.js";

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const paramsPath = arg("params");
const logs = arg("logs");
const out = arg("out");
if (paramsPath === undefined || logs === undefined || out === undefined) {
  console.error("--params <v3a params>, --logs <log.jsonl,...> and --out <path> are required");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} already exists; scoring never overwrites a file. Write to a new path.`);
  process.exit(2);
}
const params = loadParams(paramsPath);
const readLog = (p: string): LogEntry[] =>
  readFileSync(p, "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as LogEntry);
const readCodes = (p: string | undefined): Map<string, UnitLabel> | undefined =>
  p === undefined ? undefined : new Map(Object.entries(JSON.parse(readFileSync(p, "utf-8")) as Record<string, UnitLabel>));
const a = readCodes(arg("codes-a"));
const b = readCodes(arg("codes-b"));
const hand = readCodes(arg("hand"));
const codings: Codings | undefined = a !== undefined && b !== undefined ? { a, b, ...(hand !== undefined ? { hand } : {}) } : undefined;

let report = `# v3a scoring\n\nParams \`${paramsPath}\`; ${logs.split(",").length} run log(s).\n\n## Validity gates per run\n\n`;
const valid: { run: V3aRunLog; arm: "A" | "B" }[] = [];
for (const path of logs.split(",")) {
  const log = readLog(path);
  const meta = runMeta(log);
  const gates = checkGates(log, params, meta?.cell !== undefined ? { cell: meta.cell } : {});
  const ok = gatesPass(gates) && meta !== undefined;
  report += `- ${ok ? "VALID" : "INVALID"} \`${path}\` (arm ${meta?.arm ?? "?"}, ${meta?.volatility ?? "?"} volatility${meta?.cell !== undefined ? `, cell ${meta.cell}` : ""})\n`;
  for (const g of gates) report += `  - ${g.ok ? "PASS" : "FAIL"} ${g.name}: ${g.detail}\n`;
  if (ok) valid.push({ run: { label: path, log }, arm: meta.arm });
}
report += "\n";
const pass = loadV3aPassRates(params);
for (const arm of ["A", "B"] as const) {
  const runs = valid.filter((x) => x.arm === arm).map((x) => x.run);
  if (runs.length === 0) {
    report += `## Arm ${arm}\n\n- no valid run\n\n`;
    continue;
  }
  report += renderArmScore(scoreArm(arm, runs, params, pass, codings));
}
writeFileSync(out, report, { mode: 0o600, flag: "wx" });
console.log(report);
