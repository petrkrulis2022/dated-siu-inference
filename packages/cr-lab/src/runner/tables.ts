/**
 * The internal outputs of snapshot mode (§16.7): a daily table (pass rate, cost per attempt and cost per correct answer, by model and task), a cumulative table over every window
 * recorded, and a failure report. All arithmetic is in decimals, rounded half up only here at the end (invariant 4); a cost per correct answer with no correct answer is written as
 * "none correct", never as a number. The tables hold counts and dollars, never a Blockworks figure, but they are written under the private directory with the records they come from.
 */
import { D, roundHalfUp, type DecimalValue } from "@touchstone/sdk";
import { TASKS } from "../tasks/instances.js";
import type { AnswerRecord } from "./records.js";
import { PRIORITY, type FailureClass } from "./taxonomy.js";

interface Agg {
  attempts: number;
  passes: number;
  usd: DecimalValue;
}
const empty = (): Agg => ({ attempts: 0, passes: 0, usd: new D(0) });
function add(a: Agg, r: AnswerRecord): void {
  a.attempts += 1;
  if (r.passed) a.passes += 1;
  a.usd = a.usd.plus(r.usd);
}

const rate = (a: Agg): string =>
  a.attempts === 0 ? "n/a" : roundHalfUp(new D(a.passes).times(100).div(a.attempts), 1);
const perAttempt = (a: Agg): string =>
  a.attempts === 0 ? "n/a" : roundHalfUp(a.usd.div(a.attempts), 4);
const perCorrect = (a: Agg): string =>
  a.passes === 0 ? "none correct" : roundHalfUp(a.usd.div(a.passes), 4);

function row(cells: string[]): string {
  return `| ${cells.join(" | ")} |`;
}
const HEAD = [
  "| Model | Task | Attempts | Passed | Pass rate % | Cost USD | Cost per attempt | Cost per correct |",
  "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
];
const cells = (model: string, task: string, a: Agg): string =>
  row([
    model,
    task,
    String(a.attempts),
    String(a.passes),
    rate(a),
    roundHalfUp(a.usd, 4),
    perAttempt(a),
    perCorrect(a),
  ]);

/** Rows by model and task, then each model's total, then the grand total. */
function body(records: readonly AnswerRecord[]): string[] {
  const models = [...new Set(records.map((r) => r.model))].sort();
  const lines: string[] = [];
  const grand = empty();
  for (const m of models) {
    const total = empty();
    for (const t of TASKS) {
      const a = empty();
      for (const r of records) if (r.model === m && r.task === t) add(a, r);
      if (a.attempts === 0) continue;
      lines.push(cells(m, t, a));
      total.attempts += a.attempts;
      total.passes += a.passes;
      total.usd = total.usd.plus(a.usd);
    }
    lines.push(cells(`**${m}**`, "**all**", total));
    grand.attempts += total.attempts;
    grand.passes += total.passes;
    grand.usd = grand.usd.plus(total.usd);
  }
  lines.push(cells("**all models**", "**all**", grand));
  return lines;
}

export function dailyTable(
  records: readonly AnswerRecord[],
  window: string,
  label = "Snapshot mode",
): string {
  const mine = records.filter((r) => r.window === window);
  return [
    `## ${label}, ${window}`,
    "",
    mine.length === 0
      ? "No answers recorded for this window."
      : [...HEAD, ...body(mine)].join("\n"),
    "",
  ].join("\n");
}

export function cumulativeTable(records: readonly AnswerRecord[], label = "Snapshot mode"): string {
  const windows = [...new Set(records.map((r) => r.window))].sort();
  return [
    `## ${label}, cumulative`,
    "",
    windows.length === 0
      ? "No answers recorded."
      : `Windows: ${windows[0]} to ${windows[windows.length - 1]} (${windows.length} window${windows.length === 1 ? "" : "s"}).`,
    "",
    ...(records.length === 0 ? [] : [...HEAD, ...body(records)]),
    "",
  ].join("\n");
}

/** Failed answers by model and primary class, the secondary classes seen, and every unclassified failure in full. */
export function failureReport(records: readonly AnswerRecord[], window?: string): string {
  const mine = window === undefined ? records : records.filter((r) => r.window === window);
  const failed = mine.filter((r) => !r.passed);
  const models = [...new Set(mine.map((r) => r.model))].sort();
  const lines = [`## Failures${window === undefined ? ", cumulative" : `, ${window}`}`, ""];
  if (failed.length === 0) {
    lines.push(`No failed answers among ${mine.length} recorded.`, "");
    return lines.join("\n");
  }
  lines.push(
    `${failed.length} failed of ${mine.length} answers. Each failure is counted once, under its primary class.`,
    "",
    row(["Class", ...models, "All"]),
    row(["---", ...models.map(() => "---:"), "---:"]),
  );
  for (const c of PRIORITY) {
    const inClass = failed.filter((r) => r.primary_failure === c);
    if (inClass.length === 0) continue;
    lines.push(
      row([
        c,
        ...models.map((m) => String(inClass.filter((r) => r.model === m).length)),
        String(inClass.length),
      ]),
    );
  }
  const secondary = new Map<FailureClass, number>();
  for (const r of failed)
    for (const c of r.failure_classes)
      if (c !== r.primary_failure) secondary.set(c, (secondary.get(c) ?? 0) + 1);
  if (secondary.size > 0)
    lines.push(
      "",
      `Also present beside the primary class: ${PRIORITY.filter((c) => secondary.has(c))
        .map((c) => `${c} ${secondary.get(c)}`)
        .join(", ")}.`,
    );
  const fenced = mine.filter((r) => r.fenced).length;
  if (fenced > 0)
    lines.push(
      "",
      `${fenced} repl${fenced === 1 ? "y was" : "ies were"} inside a fenced block (noted, not a failure).`,
    );
  const unclassified = failed.filter((r) => r.primary_failure === "unclassified");
  if (unclassified.length > 0) {
    lines.push("", "### Unclassified, for review", "");
    for (const r of unclassified)
      lines.push(
        `- ${r.window} ${r.instance} ${r.model}: ${r.failures.map((f) => `${f.code}: ${f.detail}`).join("; ") || "(no gate failure recorded)"}`,
      );
  }
  lines.push("");
  return lines.join("\n");
}
