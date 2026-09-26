import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { formatVerifyReport, verifyPrint } from "../verify.js";
import { loadPrint, printsDir, verifyDataDir } from "./load-inputs.js";
import { buildVerifyInput } from "./verify-support.js";

/**
 * Runs verify across every published print — build1-spec.md's own public claim ("every print is
 * independently verifiable") is otherwise only ever checked one print at a time, by hand, which
 * is exactly how four (later found to be 22) real published prints stayed silently unverifiable
 * for a real stretch of time before anyone noticed (found live, 2026-09-26). Exit code drives CI:
 * a print not on the known-divergences allowlist that fails is a NEW, uninvestigated failure and
 * must fail the build; an allowlisted print's own divergence is printed for visibility but never
 * fails it.
 *
 * Known, accepted limitation of the allowlist approach (disclosed, not hidden): an allowlisted
 * print is skipped as a *whole*, not field-by-field — if a genuinely new, unrelated bug ever
 * affected an already-allowlisted print, this check alone would not catch it. Mitigated by the
 * allowlist requiring a specific, reviewed reason per print (never a blanket "ignore this id"),
 * and by every entry pointing at that print's own correction_notes, which a human still reads.
 */

interface DivergenceEntry {
  print_id: string;
  reason: string;
}

async function loadKnownDivergences(): Promise<Map<string, string>> {
  const path = join(verifyDataDir(), "known-verify-divergences.json");
  const text = await readFile(path, "utf-8").catch(() => undefined);
  if (!text) return new Map();
  const parsed = JSON.parse(text) as { divergences: DivergenceEntry[] };
  return new Map(parsed.divergences.map((d) => [d.print_id, d.reason]));
}

/** Every published print file — blended, tier series, and same-day retries alike — excluding
 * the two files that aren't prints at all (index.json, latest.json). */
async function listPrintIds(): Promise<string[]> {
  const files = await readdir(printsDir());
  return files
    .filter((f) => f.endsWith(".json"))
    .filter((f) => f !== "index.json" && f !== "latest.json")
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

const knownDivergences = await loadKnownDivergences();
const printIds = await listPrintIds();

let newFailures = 0;
let disclosedDivergences = 0;
let clean = 0;

for (const printId of printIds) {
  const print = await loadPrint(join(printsDir(), `${printId}.json`));
  const { input, manifestDiscrepancy, loadErrorMessage } = await buildVerifyInput(print);
  if (loadErrorMessage) {
    console.error(`${printId}: could not load recomputation inputs (${loadErrorMessage})`);
    newFailures++;
    continue;
  }

  const result = verifyPrint(print, input);
  if (manifestDiscrepancy) {
    result.ok = false;
    result.discrepancies.push(manifestDiscrepancy);
  }

  if (result.ok) {
    clean++;
    continue;
  }

  const knownReason = knownDivergences.get(printId);
  if (knownReason) {
    disclosedDivergences++;
    console.log(`${printId}: known, disclosed divergence — ${knownReason}`);
    continue;
  }

  newFailures++;
  console.error(`\n${printId}: NEW, UNDISCLOSED verify failure`);
  console.error(formatVerifyReport(print, result));
}

console.log(
  `\n${printIds.length} prints checked: ${clean} clean, ${disclosedDivergences} known/disclosed divergence(s), ${newFailures} new failure(s).`,
);
process.exit(newFailures > 0 ? 1 : 0);
