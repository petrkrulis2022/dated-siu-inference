/**
 * `pnpm --filter @touchstone/cr-lab run economy-score -- --log <path to a run's log.jsonl> [--params <path, defaults to the committed economy-params.json>]
 *    [--write-blind <path>] [--tags <path>] [--out <path>]`
 *
 * Scores a run's ordered log against the pre-registered measures and kill criteria (`scoring.ts`, `docs/marketplace_plan.md` §16.9), from the log file alone — it never
 * needs the run's own process still running, so it works on the live counted run's log right after it finishes, or on any stored log read back later (the rehearsal's,
 * DW4's, or a future counted window's own).
 *
 * Unclassified exits must be tagged BLIND before the thesis's 20% threshold is scored (the owner, 2026-11-07): run once with `--write-blind <path>` to get the list (keys
 * and reasoning text alone, nothing that identifies the agent, the window or the amount), read and classify each one by hand into "dollar cost", "price move", "fear" or
 * "other" (never "structural dollar route": the scoring itself decides that), write `{"<key>": "<class>", ...}` to a file, then run again with `--tags <that file>`. If
 * every exit is already classified "structural dollar route" (or there are no exits), scoring runs straight away with no tag file needed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { loadParams, PARAMS_PATH } from "../economy/params.js";
import { exitsToTagBlind, renderScoringReport, scoreRun, type ExitClass } from "../economy/scoring.js";
import type { LogEntry } from "../economy/log.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};

const logPath = arg("--log");
if (logPath === undefined) {
  console.error("--log <path to a run's log.jsonl> is required");
  process.exit(2);
}
const params = loadParams(arg("--params", PARAMS_PATH));
const log: LogEntry[] = readFileSync(logPath, "utf-8")
  .split("\n")
  .filter((l) => l.trim() !== "")
  .map((l) => JSON.parse(l) as LogEntry);

const writeBlind = arg("--write-blind");
if (writeBlind !== undefined) {
  const blind = exitsToTagBlind(log);
  writeFileSync(writeBlind, `${JSON.stringify(blind, null, 1)}\n`, { mode: 0o600 });
  console.log(
    `${blind.length} exit(s) need a blind tag; wrote ${writeBlind}. Tag each key "dollar cost", "price move", "fear" or "other" ` +
      `in a {"<key>": "<class>", ...} file, then run again with --tags <that file>.`,
  );
  process.exit(0);
}

const VALID_CLASSES = new Set<ExitClass>(["dollar cost", "price move", "fear", "other"]);
const blind = exitsToTagBlind(log);
const tagsPath = arg("--tags");
const tags = new Map<string, ExitClass>();
if (tagsPath !== undefined) {
  const raw = JSON.parse(readFileSync(tagsPath, "utf-8")) as Record<string, string>;
  for (const [k, v] of Object.entries(raw)) {
    if (!VALID_CLASSES.has(v as ExitClass))
      throw new Error(`${tagsPath}: "${k}" is tagged "${v}", not one of ${[...VALID_CLASSES].join(", ")}`);
    tags.set(k, v as ExitClass);
  }
} else if (blind.length > 0) {
  console.error(
    `${blind.length} exit(s) need a blind tag before the thesis can be scored: run with --write-blind <path> first, ` +
      `then --tags <the completed file>.`,
  );
  process.exit(2);
}

const result = scoreRun(log, params, tags);
const report = renderScoringReport(result);
console.log(report);
const out = arg("--out");
if (out !== undefined) writeFileSync(out, report, { mode: 0o600 });
process.exitCode = result.thesis.untagged.length === 0 ? 0 : 1;
