#!/usr/bin/env -S pnpm exec tsx
// One-off script, run once on 2026-09-25 (same day as backfill-sigfig-correction-notes.ts, which
// this follows), not a permanent CLI. docs/methodology.md's Rounding section: the rounding
// backfill's own correction_notes say "the real value is X," which overclaims for any print whose
// basket_costs were ALSO built from under-priced usage — the reasoning-token / cached-input
// pricing bugs, already disclosed in that same print's own earlier correction_notes. For those
// prints, X is the unrounded version of a figure already known to need a further correction this
// recomputation does not make. This script finds exactly those prints (one that already carries
// both a rounding-correction note and a reasoning/cache pricing-correction note, real detection,
// not a hardcoded list) and appends ONE further correction_notes entry stating this plainly —
// matching the established "Correction to this print's own correction note above" convention
// (data/prints/2026-09-10.json's real Gemini-saga notes). Same append-only, body-hash-unchanged
// discipline as backfill-sigfig-correction-notes.ts; idempotent via its own marker.
//
// Usage: pnpm exec tsx scripts/correct-precision-vs-accuracy-wording.ts [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Print } from "@touchstone/sdk";
import { listPrintFiles, printBodyHashHex } from "@touchstone/print";

const PRINTS_DIR = resolve(import.meta.dirname, "..", "data", "prints");
const TODAY = "2026-09-25";

const ROUNDING_MARKER = "dated_siu previously rounded to a fixed 4 decimal places";
const PRICING_MARKERS = ["reasoning", "cached_input", "cache"];
// This script's own idempotency marker — distinct from ROUNDING_MARKER, which every one of the
// 24 target prints already carries from the prior script and would otherwise always match.
const OWN_MARKER = "restores rounding precision only";

function hasRoundingCorrection(print: Print): boolean {
  return (print.correction_notes ?? []).some((n) => n.note.includes(ROUNDING_MARKER));
}

function hasPricingCorrection(print: Print): boolean {
  return (print.correction_notes ?? []).some((n) =>
    PRICING_MARKERS.some((m) => n.note.toLowerCase().includes(m)),
  );
}

function alreadyCorrected(print: Print): boolean {
  return (print.correction_notes ?? []).some((n) => n.note.includes(OWN_MARKER));
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const files = (await listPrintFiles(PRINTS_DIR)).sort();

  let latestPrintId: string | undefined;
  try {
    latestPrintId = (JSON.parse(await readFile(join(PRINTS_DIR, "latest.json"), "utf-8")) as Print).print_id;
  } catch {
    latestPrintId = undefined;
  }

  let touched = 0;
  for (const file of files) {
    const path = join(PRINTS_DIR, file);
    const print = JSON.parse(await readFile(path, "utf-8")) as Print;

    if (!hasRoundingCorrection(print) || !hasPricingCorrection(print)) continue;
    if (alreadyCorrected(print)) continue;

    const bodyHashBefore = printBodyHashHex(print);

    const note = {
      published_at: TODAY,
      note:
        `Correction to this print's own rounding correction note above: that note's phrase "the ` +
        `real value is X" overstated what the recomputation shows. It restores rounding precision ` +
        `only — the precision a fixed 4-decimal-place rounding rule removed, recovered by ` +
        `recomputing Σ weight × basket_cost from this print's own published figures. It is not a ` +
        `claim that the recomputed figure is this print's true economic value. This print's own ` +
        `basket_costs are also affected by the reasoning-token and/or cached-input pricing ` +
        `correction disclosed elsewhere in these notes — usage that was under-priced before that ` +
        `fix landed — so the recomputed rounding figure is the unrounded version of a value ` +
        `already known to need that separate correction too, which this recomputation does not ` +
        `make. See docs/methodology.md's Rounding section for the general statement of this limit.`,
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

    console.log(`${dryRun ? "[dry-run] " : ""}${file}`);
    touched++;
    if (!dryRun) {
      await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
      if (print.print_id === latestPrintId) {
        await writeFile(join(PRINTS_DIR, "latest.json"), `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
        console.log(`  (mirrored into latest.json)`);
      }
    }
  }

  console.log(`\n${touched} print(s) ${dryRun ? "would receive" : "received"} the precision-vs-accuracy correction.`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
