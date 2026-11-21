import type { Print, RunRecord } from "@touchstone/sdk";
import type { AttestationClient, SecondaryAttestation } from "./anchor/attestation.js";
import { callCostOf } from "./compute/class-cost.js";
import { computePrint, type PrintInput } from "./compute/index.js";
import { CORRECTION_NOTICE, CORRECTION_RULES_REVISION, nextRevisionId } from "./correction.js";
import { D } from "./decimal.js";
import { publishPrint, type PublishResult } from "./publish.js";
import { markSuperseded } from "./publication.js";

/**
 * The corrections publish step (docs/methodology.md, the revision policy's error procedure). A correction is the next numbered revision of a
 * published print, recomputed from the original's own run records and price snapshot under CORRECTION_RULES_REVISION, keeping the original's
 * weighting and carry-forward rules (correction.ts's correctionInput builds `input`). It is published like any print, through publishPrint:
 * schema-checked, signed, anchored (a failed required anchor refuses it), written append-only. Its signed body names the original in
 * `supersedes`; the original stays as published and gains `superseded_by` with the same reason, outside its signed body. latest.json is never
 * moved back to an older date (publication.ts's writePrint).
 */
export interface PublishCorrectionInput {
  original: Print;
  /** The recomputation under the correction rule, limited to the original's constituents: correctionInput(original, buildVerifyInput(...)). */
  input: PrintInput;
  /** The defined, disclosed cause (correctionReason), written to the correction's `supersedes` and the original's `superseded_by`. */
  reason: string;
  privateKeyHex: string;
  attestationClient?: AttestationClient;
  secondaryAttestations?: SecondaryAttestation[];
}

export interface PublishCorrectionResult extends PublishResult {
  /** The original as it now stands on disk, with superseded_by. */
  original: Print;
}

type BasketRows = Pick<Print, "basket_costs">;

/** Which constituents qualify, and which of them are carried forward: a correction changes prices, never this. */
function qualifyingSet(print: BasketRows): string {
  return [...print.basket_costs]
    .map((r) => `${r.model_id}:${r.cost_usd === undefined ? "excluded" : (r.carried_forward_from ?? "measured")}`)
    .sort()
    .join(",");
}

export async function publishCorrection(printsDir: string, c: PublishCorrectionInput): Promise<PublishCorrectionResult> {
  const { original } = c;
  if (original.superseded_by) {
    throw new Error(`Refusing to correct ${original.print_id}: it is already superseded by ${original.superseded_by.print_id}. Each print is corrected once.`);
  }
  const expectedId = nextRevisionId(original.print_id);
  if (c.input.print_id !== expectedId) {
    throw new Error(`Refusing to correct ${original.print_id} as ${c.input.print_id}: its correction is the next numbered revision, ${expectedId}.`);
  }

  // Checked before anything is signed or anchored.
  const { body } = computePrint({ ...c.input, status: original.status });
  if (qualifyingSet(body) !== qualifyingSet(original)) {
    throw new Error(
      `Refusing to correct ${original.print_id}: the recomputation changes the qualifying set (${qualifyingSet(original)} -> ${qualifyingSet(body)}). ` +
        `A correction changes prices, never which constituents qualify.`,
    );
  }
  const costs = (p: BasketRows) => JSON.stringify([...p.basket_costs].map((r) => [r.model_id, r.cost_usd ?? null]).sort());
  if (
    body.dated_siu === original.dated_siu &&
    costs(body) === costs(original) &&
    body.cost_of_production_usd === original.cost_of_production_usd
  ) {
    throw new Error(`Refusing to correct ${original.print_id}: the recomputation changes no value, so there is nothing to correct.`);
  }

  const supersedes = { print_id: original.print_id, reason: c.reason };
  const result = await publishPrint(printsDir, {
    ...c.input,
    privateKeyHex: c.privateKeyHex,
    attestationClient: c.attestationClient,
    secondaryAttestations: c.secondaryAttestations,
    supersedes,
    // Facts about the measurement both prints share, signed into the original's body: the correction states them too.
    ...(original.series ? { series: original.series } : {}),
    ...(original.prior_attempts ? { priorAttempts: original.prior_attempts } : {}),
    ...(original.constituent_changes ? { constituentChanges: original.constituent_changes } : {}),
  });
  const updatedOriginal = await markSuperseded(printsDir, original.print_id, { print_id: result.print.print_id, reason: c.reason });
  return { ...result, original: updatedOriginal };
}

/**
 * The cause of a correction, in plain terms, naming each constituent whose cost changed under the error that changed it. Derived from the run
 * records and prices themselves:
 *  - a constituent whose provider counts cached tokens inside the prompt and whose calls had cached tokens: with a published cached rate they
 *    were counted twice; with none (the 2026-09-26 snapshot, for two OpenRouter models), they were priced at the full input price;
 *  - a constituent with no cached tokens whose billed figures differ from the list price it was priced at: a service-tier mismatch.
 * A changed constituent that fits neither is refused: a correction publishes only causes it can name.
 */
export function correctionReason(
  original: BasketRows,
  corrected: BasketRows,
  input: Pick<PrintInput, "models" | "carryForwardHistory">,
): string {
  const before = new Map([...original.basket_costs].map((r) => [r.model_id, r.cost_usd]));
  const changed = [...corrected.basket_costs].filter((r) => before.get(r.model_id) !== r.cost_usd);
  const byId = new Map(input.models.map((m) => [m.model_id, m]));

  const counted: string[] = [];
  const fullRate: string[] = [];
  const tier: string[] = [];
  for (const row of changed) {
    const id = row.model_id;
    const model = byId.get(id);
    if (!model) throw new Error(`Cannot state the cause of the change to ${id}: it is not among the recomputation's constituents.`);
    // A carried-forward row is the usage of the day it was measured, repriced at this print's list price (never at a billed figure).
    const carriedFrom = row.carried_forward_from;
    const records: RunRecord[] = carriedFrom
      ? (input.carryForwardHistory?.find((d) => d.date === carriedFrom)?.records.get(id) ?? [])
      : model.records;
    const label = carriedFrom ? `${id} (carried forward from ${carriedFrom})` : id;
    const cached = model.cachedInsideInput === true && records.some((r) => r.usage.cached_input > 0);
    const mispricedTier =
      !carriedFrom &&
      records.some((r) => r.usage.cached_input === 0 && r.billed_usd !== undefined && !callCostOf(r, { price: model.price }).eq(new D(r.billed_usd)));
    if (cached) (model.price.price_cached_in_usd_per_1m !== undefined ? counted : fullRate).push(label);
    if (mispricedTier) tier.push(label);
    if (!cached && !mispricedTier) {
      throw new Error(`Cannot state the cause of the change to ${label}: it had no cached tokens and was not billed at a price other than its list price.`);
    }
  }

  const clauses = [
    ...(counted.length > 0 ? [`cached prompt tokens counted twice for ${counted.join(", ")}`] : []),
    ...(fullRate.length > 0 ? [`cached prompt tokens priced at the full input price, the price snapshot having no cached rate, for ${fullRate.join(", ")}`] : []),
    ...(tier.length > 0 ? [`calls priced at a service tier other than the one they were billed on, for ${tier.join(", ")}`] : []),
  ];
  return (
    `Corrects the pricing errors set out in the ${CORRECTION_NOTICE}: ${clauses.join("; ")}. ` +
    `Recomputed under ${CORRECTION_RULES_REVISION} from this print's own run records and price snapshot, keeping its weighting and ` +
    `carry-forward rules; the qualifying set is unchanged.`
  );
}
