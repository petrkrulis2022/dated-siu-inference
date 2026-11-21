/**
 * Computes the correction of published prints under CORRECTION_RULES_REVISION (docs/methodology.md: a call's price is what its response says it was billed, and a list price counts each cached token once)
 * and shows each original beside its correction. Dry run only: it never signs, anchors or writes a print. Publishing a correction (a signed,
 * anchored numbered revision that names its original in `supersedes`, plus `superseded_by` and a correction note on the original) waits for the
 * owner's approval of these values.
 *
 *   node dist/cli/correct.js --dry-run [--out <file.json>] <print_id>...
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Print } from "@touchstone/sdk";
import { computePrint } from "../compute/index.js";
import { D } from "../decimal.js";
import { correctionInput, CORRECTION_RULES_REVISION, nextRevisionId } from "../correction.js";
import { loadPrint, printsDir } from "./load-inputs.js";
import { buildVerifyInput } from "./verify-support.js";

const args = process.argv.slice(2);
if (!args.includes("--dry-run")) {
  console.error("Only --dry-run exists: publishing a correction waits for the owner's approval of the dry-run values.");
  process.exit(2);
}
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
const ids = args.filter((a, i) => a !== "--dry-run" && a !== "--out" && (outIndex < 0 || i !== outIndex + 1));
if (ids.length === 0) {
  console.error("Name at least one print_id to correct.");
  process.exit(2);
}

function delta(from: string | undefined, to: string | undefined): string {
  if (from === undefined || to === undefined || new D(from).isZero()) return "";
  const d = new D(to).dividedBy(from).minus(1).times(100);
  return d.isZero() ? "unchanged" : `${d.isPositive() ? "+" : ""}${d.toDecimalPlaces(2).toString()}%`;
}

const results = [];
for (const id of ids) {
  const original: Print = await loadPrint(join(printsDir(), `${id}.json`));
  const revisionId = nextRevisionId(original.print_id);
  const built = await buildVerifyInput({
    ...original,
    print_id: revisionId,
    methodology_revision: CORRECTION_RULES_REVISION,
    supersedes: { print_id: original.print_id, reason: "dry run" },
  });
  if (!built.input) throw new Error(`${id}: could not build the recomputation: ${built.loadErrorMessage ?? "unknown error"}`);
  const corrected = computePrint(correctionInput(original, built.input)).body;

  const costs = original.basket_costs.map((row) => {
    const after = corrected.basket_costs.find((r) => r.model_id === row.model_id);
    return {
      model_id: row.model_id,
      original: row.cost_usd ?? `excluded: ${row.excluded_reason ?? ""}`,
      corrected: after?.cost_usd ?? `excluded: ${after?.excluded_reason ?? "(absent)"}`,
      change: delta(row.cost_usd, after?.cost_usd),
    };
  });
  results.push({
    print_id: original.print_id,
    revision_id: revisionId,
    methodology_revision: { original: original.methodology_revision, corrected: CORRECTION_RULES_REVISION },
    price_snapshot_ref: original.price_snapshot_ref,
    dated_siu: { original: original.dated_siu, corrected: corrected.dated_siu, change: delta(original.dated_siu, corrected.dated_siu) },
    cost_of_production_usd: {
      original: original.cost_of_production_usd,
      corrected: corrected.cost_of_production_usd,
      change: delta(original.cost_of_production_usd, corrected.cost_of_production_usd),
    },
    basket_costs: costs,
    corrected_body: corrected,
  });

  console.log(`\n${original.print_id} -> ${revisionId}`);
  console.log(`  dated_siu  ${original.dated_siu} -> ${corrected.dated_siu}  ${delta(original.dated_siu, corrected.dated_siu)}`);
  for (const c of costs) {
    if (c.change !== "unchanged") console.log(`  ${c.model_id.padEnd(34)} ${c.original} -> ${c.corrected}  ${c.change}`);
  }
}

if (outPath) {
  await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf-8");
  console.log(`\nWritten: ${outPath}`);
}
