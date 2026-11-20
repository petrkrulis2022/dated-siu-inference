import type { Print } from "@touchstone/sdk";
import type { PrintInput } from "./compute/index.js";

/** The rule a correction recomputes under (docs/methodology.md, rules-2026-11-20): a call's price is what its response says it was billed. */
export const CORRECTION_RULES_REVISION = "rules-2026-11-20";

const PRINT_ID = /^(\d{4}-\d{2}-\d{2})([b-y]?)(-frontier|-commodity)?$/;

/**
 * The print_id of the numbered revision that corrects `printId` (the revision policy: a correction is published as a numbered revision alongside
 * the original, never as a second write to the same id). The letter after the date counts revisions: 2026-11-17 -> 2026-11-17b,
 * 2026-11-18b -> 2026-11-18c; a series suffix stays where it is.
 */
export function nextRevisionId(printId: string): string {
  const match = PRINT_ID.exec(printId);
  if (!match) throw new Error(`Cannot number a revision of "${printId}": not a dated print id with room for another revision letter.`);
  const [, date, letter, series] = match;
  const next = letter === "" ? "b" : String.fromCharCode((letter as string).charCodeAt(0) + 1);
  return `${date}${next}${series ?? ""}`;
}

/**
 * The input that recomputes `original` as its correction: the same run records and price snapshot it was published from (`recomputed`, built by
 * buildVerifyInput for the revision), under CORRECTION_RULES_REVISION, limited to exactly the constituents the original published. A model
 * admitted to the registry after the original is not added retroactively; registry changes are never retroactive (methodology.md, Constituent
 * changes).
 */
export function correctionInput(original: Print, recomputed: PrintInput): PrintInput {
  const constituents = new Set(original.basket_costs.map((row) => row.model_id));
  return {
    ...recomputed,
    print_id: nextRevisionId(original.print_id),
    methodology_revision: CORRECTION_RULES_REVISION,
    billedCostWhereReported: true,
    models: recomputed.models.filter((m) => constituents.has(m.model_id)),
  };
}
