/**
 * v3a's issuer pass-rate table (docs/experiment-3a-design.md, "Issuers and tasks"): counted read-only from the Blockworks trial's answer ledger (dsi-cr-trial's
 * `data/private/blockworks/cr/records/*.jsonl`), then turned into each v3a issuer's pass rate per task type by the owner's rules (decision D143, 2026-11-11):
 *
 *  - ISSUER-C1, ISSUER-C2: claude-haiku-5-5's measured rate on CR-PL, CR-UO and CR-SM.
 *  - ISSUER-F: claude-sonnet-5's measured rate on all four types.
 *  - ISSUER-X: not a measured cell. D119's qualifying floor, 80%, on CR-PL, CR-UO and CR-SM, as a pre-registered rule: the trial's own weakest qualifying cell (sonnet-5,
 *    CR-PL, 9 of 10) is statistically indistinguishable from C1/C2 and would leave the claims record with no defaults to show (the owner's reasoning, kept with the rule).
 *
 * Counted exactly as WP0 counts (D70): snapshot-mode answers only, the parts `snapshot` and `dry-run`; MCP sessions never count. A superseded file (`*.pre-*.jsonl`, kept
 * from a regrade or rerun) is never read: the current file for that day replaces it. Unlike WP0's cost, every answer counts, including one whose headline cost could not be
 * derived (it is still an executed answer that passed or failed); the one place that differs from cr-print.json is noted in the export.
 *
 * Only counts leave the ledger: no answer, prompt, figure or reasoning is read beyond `part`, `model`, `task` and `passed`.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TASKS, type TaskId } from "../tasks/instances.js";

/** D119: the pass rate a model needs on a task type to issue claims for it, in basis points */
export const QUALIFYING_FLOOR_BPS = 8_000;

export interface Count {
  answers: number;
  passes: number;
}
export type Counts = Record<string, Partial<Record<TaskId, Count>>>;

const COUNTED_PARTS = new Set(["snapshot", "dry-run"]);

/** the ledger files that count: one current file per day, never a superseded `*.pre-*.jsonl` */
export function countedFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
}

/** answers and passes per model and task type, from JSONL record lines (only `part`, `model`, `task` and `passed` are read) */
export function countPasses(lines: Iterable<string>): Counts {
  const out: Counts = {};
  for (const line of lines) {
    if (line.trim() === "") continue;
    const r = JSON.parse(line) as { part?: unknown; model?: unknown; task?: unknown; passed?: unknown };
    if (typeof r.part !== "string" || !COUNTED_PARTS.has(r.part)) continue;
    if (typeof r.model !== "string" || !TASKS.includes(r.task as TaskId)) continue;
    const byTask = (out[r.model] ??= {});
    const c = (byTask[r.task as TaskId] ??= { answers: 0, passes: 0 });
    c.answers++;
    if (r.passed === true) c.passes++;
  }
  return out;
}

/** passes per 10,000 answers, rounded down (the stand-in worker's own unit) */
export const rateBps = (c: Count): number => Math.floor((c.passes * 10_000) / c.answers);

export interface IssuerRate {
  bps: number;
  /** where the rate comes from: a measured cell (model, counts) or the pre-registered rule */
  source: { model: string; answers: number; passes: number } | { rule: string };
}
export type IssuerPassTable = Record<string, Partial<Record<TaskId, IssuerRate>>>;

const COMMODITY_TYPES: readonly TaskId[] = ["CR-PL", "CR-UO", "CR-SM"];

/** v3a's four issuers' pass rates per task type, by the owner's rules (this module's doc comment) */
export function v3aIssuerPassTable(counts: Counts): IssuerPassTable {
  const measured = (model: string, task: TaskId): IssuerRate => {
    const c = counts[model]?.[task];
    if (c === undefined || c.answers === 0) throw new Error(`the trial ledger has no ${model} answers on ${task}`);
    return { bps: rateBps(c), source: { model, answers: c.answers, passes: c.passes } };
  };
  const floor: IssuerRate = {
    bps: QUALIFYING_FLOOR_BPS,
    source: { rule: "D119's qualifying floor (80%), pre-registered for ISSUER-X (owner, D143)" },
  };
  const of = (model: string, tasks: readonly TaskId[]) =>
    Object.fromEntries(tasks.map((t) => [t, measured(model, t)])) as Partial<Record<TaskId, IssuerRate>>;
  return {
    "ISSUER-C1": of("claude-haiku-5-5", COMMODITY_TYPES),
    "ISSUER-C2": of("claude-haiku-5-5", COMMODITY_TYPES),
    "ISSUER-X": Object.fromEntries(COMMODITY_TYPES.map((t) => [t, floor])) as Partial<Record<TaskId, IssuerRate>>,
    "ISSUER-F": of("claude-sonnet-5", TASKS),
  };
}

export interface PassRateExport {
  note: string;
  sourceDir: string;
  files: { file: string; sha256: string }[];
  /** sha256 over "<file> <sha256>\n" for every file, in order: one hash that pins the whole source */
  sourceSha256: string;
  counts: Counts;
  issuers: IssuerPassTable;
}

export function exportPassRates(dir: string, label = dir): PassRateExport {
  const files = countedFiles(dir).map((file) => {
    const text = readFileSync(join(dir, file));
    return { file, sha256: createHash("sha256").update(text).digest("hex"), text: text.toString("utf-8") };
  });
  const counts = countPasses(files.flatMap((f) => f.text.split("\n")));
  return {
    note:
      "v3a issuer pass rates (docs/experiment-3a-design.md; decision D143). Counts are snapshot-mode answers only (parts snapshot and dry-run, D70), every answer counted; superseded *.pre-*.jsonl files are not read. Only part, model, task and passed were read from the ledger. One difference from cr-print.json: claude-sonnet-5 on CR-PL is 9 of 10 here and 9 of 9 there, because WP0's cost leaves out the one answer whose headline cost could not be derived (it failed).",
    sourceDir: label,
    files: files.map(({ file, sha256 }) => ({ file, sha256 })),
    sourceSha256: createHash("sha256")
      .update(files.map((f) => `${f.file} ${f.sha256}\n`).join(""))
      .digest("hex"),
    counts,
    issuers: v3aIssuerPassTable(counts),
  };
}
