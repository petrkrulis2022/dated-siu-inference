#!/usr/bin/env -S pnpm exec tsx
// One-off script, run once on 2026-09-25, not a permanent CLI — matching how the Gemini-cost-gap
// correction_notes were added (git history, e.g. commit 5ee657a: hand-authored notes, not a
// reusable tool). docs/methodology.md's Rounding section: dated_siu previously rounded to a fixed
// 4 decimal places, which is too coarse a precision once a series' price level falls low enough
// (confirmed: Commodity SIU published the identical "0.0014" for 23 straight days). Fixed forward
// only — no print is ever recomputed or re-signed (packages/print/src/publication.ts's append-
// only guarantee). This script finds every already-published print whose dated_siu would differ
// under the corrected 4-significant-figure rule, and appends one correction_notes entry to it
// stating the recomputed figure — reproducible from that print's own published basket_costs and
// weights alone, per docs/methodology.md's own reproducibility point. correction_notes is
// excluded from the signed payload (packages/print/src/sign/canonicalise.ts), so this never
// touches signature, public_key, or anchor — verified explicitly below, not just assumed.
//
// Usage: pnpm exec tsx scripts/backfill-sigfig-correction-notes.ts [--dry-run]

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Print } from "@touchstone/sdk";
import { D, listPrintFiles, printBodyHashHex, roundSignificantFigures, sum } from "@touchstone/print";

const PRINTS_DIR = resolve(import.meta.dirname, "..", "data", "prints");
const SIG_FIGS = 4;
const TODAY = "2026-09-25";
// Marks a correction_notes entry as this fix's own — checked before appending so a second run
// (e.g. after merging in a same-day print published before this fix landed) is a no-op for every
// print already carrying one, rather than appending a duplicate note.
const MARKER = "dated_siu previously rounded to a fixed 4 decimal places";

function recomputeDatedSiu(print: Print): DecimalOrUndefined {
  const costByModel = new Map(
    print.basket_costs.filter((r) => r.cost_usd !== undefined).map((r) => [r.model_id, r.cost_usd as string]),
  );
  const terms = [];
  for (const { model_id, weight } of print.weights.values) {
    const cost = costByModel.get(model_id);
    if (cost === undefined) return undefined; // shouldn't happen for a published print
    terms.push(new D(weight).times(cost));
  }
  return sum(terms);
}

type DecimalOrUndefined = ReturnType<typeof sum> | undefined;

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  // listPrintFiles (packages/print/src/publication.ts) already excludes index.json/latest.json —
  // neither is an independently signed print. latest.json is a byte-identical copy of the newest
  // blended (series-less) print (same file's own doc comment); kept in sync explicitly below.
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

    if ((print.correction_notes ?? []).some((n) => n.note.includes(MARKER))) {
      continue; // already corrected by a prior run of this script — idempotent re-run
    }

    const recomputedFull = recomputeDatedSiu(print);
    if (recomputedFull === undefined) {
      console.log(`SKIP  ${file} — a weighted model has no basket_cost (unexpected, investigate)`);
      continue;
    }
    const recomputed = roundSignificantFigures(recomputedFull, SIG_FIGS);
    const published = print.dated_siu;

    if (new D(recomputed).equals(new D(published))) {
      continue; // nothing lost for this print — no note needed
    }

    const bodyHashBefore = printBodyHashHex(print);

    const note = {
      published_at: TODAY,
      note:
        `dated_siu previously rounded to a fixed 4 decimal places rather than 4 significant ` +
        `figures — found live and fixed the same day, 2026-09-25 (docs/methodology.md's Rounding ` +
        `section). At this print's price level that was too coarse to show real day-to-day ` +
        `movement. This print's signed body is never edited — the published figure (${published}) ` +
        `stands. Recomputed from this print's own published basket_costs and weights ` +
        `(Σ weight × basket_cost, rounded under the corrected 4-significant-figure rule, ` +
        `reproducible by anyone from this print's own published figures alone), the real value is ` +
        `${recomputed}.`,
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

    console.log(`${dryRun ? "[dry-run] " : ""}${file}: published=${published} recomputed=${recomputed}`);
    touched++;
    if (!dryRun) {
      await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`, "utf-8");
      // Keep latest.json a byte-identical copy of the newest blended print — its own established
      // invariant (publication.ts's writePrint does the same on every normal publish).
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
