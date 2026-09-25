#!/usr/bin/env -S pnpm exec tsx
// One-off script, run once on 2026-09-25, not a permanent CLI — same discipline as
// scripts/backfill-sigfig-correction-notes.ts. docs/methodology.md's rules-2026-09-25b: the
// cached-input pricing fix (29d4be2, 2026-09-13) never actually reached the cost formula —
// buildModelInputs (packages/print/src/cli/load-inputs.ts) never forwarded a snapshot's
// price_cached_in_usd_per_1m — fixed the same commit this script's own correction_notes cites
// (327d7b9). This is a DISCLOSURE-ONLY correction: it states the real, structural fact plainly on
// every real print that was published under the false belief the fix was already live, and names
// which of that print's own basket_costs models are known, from that print's own real run
// records, to have carried nonzero cached usage. It does NOT compute a corrected cost_usd or
// dated_siu figure — that quantified backfill is separate, deferred follow-up work (per the
// user's own explicit instruction), tracked here only as "figures follow", never invented.
//
// Never touches signature/public_key/anchor — printBodyHashHex asserted unchanged before/after,
// exactly like the sigfig script.
//
// Usage: pnpm exec tsx scripts/backfill-cached-input-wiring-bug-disclosure.ts [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Print, RunRecord } from "@touchstone/sdk";
import { listPrintFiles, printBodyHashHex } from "@touchstone/print";

const PRINTS_DIR = resolve(import.meta.dirname, "..", "data", "prints");
const RUNS_DIR = resolve(import.meta.dirname, "..", "data", "runs");
const TODAY = "2026-09-25";
const FIX_COMMIT = "327d7b9";
// The exact window every real print was published under the false belief this fix was already
// live: the first print date after commit 29d4be2 (2026-09-13's own print predates the belief —
// its own correction_notes already correctly disclose the pre-fix gap) through today's own print,
// itself computed before this session's actual fix landed.
const FIRST_AFFECTED_DATE = "2026-09-14";
const LAST_AFFECTED_DATE = "2026-09-25";
// Confirmed via a real scan of every affected date's own run records (not assumed): the only
// models that actually show nonzero cached_input usage in this window, of the six with a real
// published cached rate at some point. claude-sonnet-5/gpt-5.1/claude-haiku-4-5/gpt-5.4-mini also
// had a published rate but never show real cached usage in this window's own run records.
const MODELS_WITH_REAL_CACHED_USAGE = [
  "deepseek-v3.2",
  "mistral-small-3.2-24b-instruct",
  "grok-4.6",
  "gemini-3.1-pro-preview",
];
const MARKER = "buildModelInputs never forwarded";

async function modelsWithRealCachedUsage(printDate: string): Promise<string[]> {
  const dir = join(RUNS_DIR, printDate);
  const files = await readdir(dir).catch(() => [] as string[]);
  const found = new Set<string>();
  for (const f of files) {
    if (!f.endsWith(".json") || f.endsWith(".raw.json") || f === "index.json" || f === "reconciliation.json") {
      continue;
    }
    const record = JSON.parse(await readFile(join(dir, f), "utf-8")) as RunRecord;
    if (MODELS_WITH_REAL_CACHED_USAGE.includes(record.model_id) && record.usage.cached_input > 0) {
      found.add(record.model_id);
    }
  }
  return [...found].sort();
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const files = (await listPrintFiles(PRINTS_DIR)).sort();

  let touched = 0;
  let latestPrintId: string | undefined;
  try {
    latestPrintId = (JSON.parse(await readFile(join(PRINTS_DIR, "latest.json"), "utf-8")) as Print).print_id;
  } catch {
    latestPrintId = undefined;
  }

  for (const file of files) {
    const path = join(PRINTS_DIR, file);
    const raw = await readFile(path, "utf-8");
    const print = JSON.parse(raw) as Print;

    if (print.date < FIRST_AFFECTED_DATE || print.date > LAST_AFFECTED_DATE) {
      continue;
    }
    if ((print.correction_notes ?? []).some((n) => n.note.includes(MARKER))) {
      continue; // already corrected by a prior run of this script — idempotent re-run
    }

    const costedModelIds = new Set(
      print.basket_costs.filter((b) => b.cost_usd !== undefined).map((b) => b.model_id),
    );
    const affectedHere = (await modelsWithRealCachedUsage(print.date)).filter((m) =>
      costedModelIds.has(m),
    );
    if (affectedHere.length === 0) {
      console.log(`SKIP  ${file} — no affected model with a costed basket_costs row this date`);
      continue;
    }

    const bodyHashBefore = printBodyHashHex(print);

    const note = {
      published_at: TODAY,
      note:
        `This print was published under the belief that cached-input pricing (rules-2026-09-13, ` +
        `commit 29d4be2) was already live — docs/methodology.md stated this as fact. It was not: ` +
        `buildModelInputs never forwarded a price snapshot's price_cached_in_usd_per_1m to the ` +
        `cost formula, for any model, from any source, until this was found and fixed live ` +
        `2026-09-25 (commit ${FIX_COMMIT}, docs/methodology.md's rules-2026-09-25b). For this ` +
        `print specifically, real nonzero cached_input usage on ${affectedHere.join(", ")} — ` +
        `already present in this print's own run records — was still priced at zero in this ` +
        `print's own signed cost_of_production_usd and basket_costs, contrary to what the ` +
        `methodology this print's date falls under claimed. This print's signed body is never ` +
        `edited. The exact, per-model corrected dollar figure is not computed here — that ` +
        `quantified backfill is separate, deferred follow-up work; this note discloses the ` +
        `structural fact, not yet the number.`,
    };

    const updated: Print = {
      ...print,
      correction_notes: [...(print.correction_notes ?? []), note],
    };

    const bodyHashAfter = printBodyHashHex(updated);
    if (bodyHashBefore !== bodyHashAfter) {
      throw new Error(
        `${file}: appending correction_notes changed the print's own body hash ` +
          `(${bodyHashBefore} -> ${bodyHashAfter}) — refusing to write. This should be ` +
          `impossible (correction_notes is excluded from printBodyOf); stop and investigate.`,
      );
    }

    console.log(`${dryRun ? "[dry-run] " : ""}${file}: affected models = ${affectedHere.join(", ")}`);
    touched++;
    if (!dryRun) {
      await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
      if (print.print_id === latestPrintId) {
        await writeFile(join(PRINTS_DIR, "latest.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
        console.log(`  (mirrored into latest.json)`);
      }
    }
  }

  console.log(`\n${touched} print(s) ${dryRun ? "would receive" : "received"} a correction_notes entry.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
