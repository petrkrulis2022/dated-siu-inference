/**
 * Runs the numeric-scale check (`lab/numeric-check.ts`, D65) over a finished battery run: `pnpm run lab-numeric-check -- <run directory name>`. For each call it checks
 * the stated reason and the thinking summary against the figures on that call's own screen, writes `numeric-flags.json` into the run directory and prints the
 * counts. Flagged replies stay in every count; this only reports them. It reads no choice and no category, so it is safe to run before the analysis, but it is
 * run once the run is complete, not during it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BatteryCall } from "../lab/battery-run.js";
import { numericFlags, screenFigures, type CellFacts, type NumericFlag } from "../lab/numeric-check.js";
import { REPO_ROOT } from "./p5-shared.js";

interface Manifest {
  cells: Record<string, { printByRound: string[]; round: number; heldUsdcMinor: string; heldFsiuMilliSiu: string }>;
}

function main(): void {
  const runId = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (runId === undefined) throw new Error("name the run directory under data/lab/probes/battery/");
  const dir = join(REPO_ROOT, "data/lab/probes/battery", runId);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8")) as Manifest;
  const calls = readFileSync(join(dir, "calls.jsonl"), "utf-8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as BatteryCall);

  const flagged: { key: string; cell: string; arm: string; model: string; source: "stated_reason" | "thinking"; flags: NumericFlag[] }[] = [];
  for (const c of calls) {
    const facts: CellFacts = manifest.cells[c.cell];
    const figures = screenFigures(facts);
    for (const [source, text] of [["stated_reason", c.parsed.statedReason], ["thinking", c.thinking]] as const) {
      const flags = numericFlags(text, figures);
      if (flags.length > 0) flagged.push({ key: c.key, cell: c.cell, arm: c.arm, model: c.model, source, flags });
    }
  }
  writeFileSync(
    join(dir, "numeric-flags.json"),
    `${JSON.stringify({ check: "lab/numeric-check.ts, D65: a stated figure that is a power of ten away from a figure on the screen, or a dollar figure far larger than the whole wallet. It does not catch other arithmetic slips.", calls: calls.length, repliesWithAFlag: new Set(flagged.map((f) => f.key)).size, flagged }, null, 2)}\n`,
  );
  const replies = new Set(flagged.map((f) => f.key));
  console.log(`${calls.length} calls; ${replies.size} carry at least one flagged figure (stated reason or thinking). Saved ${join(dir, "numeric-flags.json")}.`);
  const by = new Map<string, number>();
  for (const f of flagged) by.set(`${f.model} arm ${f.arm}`, (by.get(`${f.model} arm ${f.arm}`) ?? 0) + 1);
  for (const [k, v] of [...by].sort()) console.log(`  ${k}: ${v}`);
}

main();
