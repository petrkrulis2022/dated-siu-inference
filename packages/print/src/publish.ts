import { validateRunRecord, validatePrint, type Print } from "@touchstone/sdk";
import { computePrint, computeCostOfProduction, type PrintInput } from "./compute/index.js";
import { signPrintBody } from "./sign/sign.js";
import { printBodyHashHex } from "./sign/canonicalise.js";
import {
  writePrint,
  writePrintsIndex,
  writeRunManifest,
  type WritePrintResult,
} from "./publication.js";
import {
  StubAttestationClient,
  type AnchorResult,
  type AttestationClient,
} from "./anchor/attestation.js";

export interface InvalidRecordReport {
  model_id: string;
  run_id: string;
  errors: string[];
}

/**
 * The floor below which a print refuses to publish at all — methodology.md's registry
 * inclusion policy. Below this, a single constituent moves the print more than the market
 * does, which is a materially different (and materially thinner) reference set than the one
 * the registry is meant to represent, not just a worse measurement of the same thing. Found
 * live: a run against a congested/unfunded provider key qualified only 2 of 6 registered
 * models and still published — this constant exists so that can't happen silently again.
 */
export const MINIMUM_QUALIFYING_MODELS = 4;

/**
 * Thrown instead of a bare Error so a caller (cli/publish-unattended.ts, on a failed attempt)
 * can report the qualifying-set shortfall as structured data — qualifying/registered counts and
 * the real spend already incurred — rather than parsing it back out of the message string. The
 * message itself is unchanged, so existing callers matching on text (the workflow's own
 * grep "^Error:") keep working.
 */
export class QualifyingSetError extends Error {
  constructor(
    public readonly qualifying: number,
    public readonly registered: number,
    public readonly costUsd: string,
  ) {
    super(
      `Refusing to publish: only ${qualifying} of ${registered} registered models qualified ` +
        `(minimum ${MINIMUM_QUALIFYING_MODELS}) — this reference set is too thin to constitute a ` +
        `print, not merely a worse measurement of the usual one. See methodology.md's registry ` +
        `inclusion policy.`,
    );
    this.name = "QualifyingSetError";
  }
}

export interface PriorAttempt {
  attempted_at: string;
  reason: string;
  qualifying_models: number;
  registered_models: number;
  cost_usd: string;
}

export interface ConstituentChange {
  model_id: string;
  change: "admitted" | "removed";
}

/**
 * Diffs the registry's current model ids against the immediately preceding print's own
 * `basket_costs` model ids — every registered model as of that print, qualifying or not, so a
 * model merely excluded from one print's reference set (a bad day, still in the registry) is
 * never confused with an actual registry removal. Returns [] when there's no previous print
 * (the very first one) or nothing changed — never fabricates a change that didn't happen.
 *
 * Deliberately a pure function over already-loaded data, not something publishPrint reaches
 * out and loads itself — the CLI already loads both the registry and the previous print for
 * other reasons, and passing them in keeps this testable without a filesystem.
 */
export function computeConstituentChanges(
  registryModelIds: string[],
  previousPrint: Pick<Print, "basket_costs"> | undefined,
): ConstituentChange[] {
  if (!previousPrint) return [];
  const previousIds = new Set(previousPrint.basket_costs.map((bc) => bc.model_id));
  const currentIds = new Set(registryModelIds);

  const admitted = registryModelIds
    .filter((id) => !previousIds.has(id))
    .map((model_id): ConstituentChange => ({ model_id, change: "admitted" }));
  const removed = [...previousIds]
    .filter((id) => !currentIds.has(id))
    .map((model_id): ConstituentChange => ({ model_id, change: "removed" }));

  return [...admitted, ...removed];
}

/**
 * Same diff as computeConstituentChanges, scoped to one tier series (design-doc §4a). The
 * registry doesn't carry per-print tier history, so this recovers which of the previous print's
 * basket_costs belonged to this tier by cross-referencing the CURRENT registry's open_weights —
 * a fair approximation since open_weights is fixed at admission (registry inclusion policy
 * criterion 4) and doesn't change over a model's life in the registry.
 *
 * `previousPrint` is always the previous Dated SIU print — published daily, covering the full
 * registry across both tiers — never a per-series previous print. This is deliberate, not a
 * shortcut: it means a tier series' very first print correctly discloses only its genuinely new
 * admissions (the models that triggered that day's registry change), not its entire founding
 * membership as if every constituent had just been admitted; and a model admitted or removed in
 * the other tier never leaks into this tier's diff as a false entry, since the previous print's
 * basket_costs is filtered down to this tier before diffing, not compared wholesale.
 *
 * Known limitation, disclosed rather than silently wrong: a model removed from the registry
 * entirely can no longer be looked up in the current registry, so it cannot be attributed to
 * either tier here and is omitted from every tier-scoped diff — it still appears correctly in
 * Dated SIU's own (registry-wide, not tier-scoped) constituent_changes.
 */
export function computeConstituentChangesForSeries(
  currentTierModelIds: string[],
  previousPrint: Pick<Print, "basket_costs"> | undefined,
  currentRegistryOpenWeightsById: Map<string, boolean>,
  wantOpenWeights: boolean,
): ConstituentChange[] {
  if (!previousPrint) return [];
  const previousTierIds = previousPrint.basket_costs
    .map((bc) => bc.model_id)
    .filter((id) => currentRegistryOpenWeightsById.get(id) === wantOpenWeights);
  // Print["basket_costs"] is a non-empty tuple by schema — this internal diffing object is
  // never itself serialised or schema-validated (only computeConstituentChanges reads
  // .basket_costs off it, to pull model ids back out), so the empty-array case genuinely
  // possible here (a tier with zero constituents as of the previous Dated SIU print — e.g. the
  // day before this tier's very first admission) is a real, valid input, not a schema
  // violation; the type is asserted past the tuple constraint rather than special-cased away,
  // so that case still correctly reads every current id in this tier as newly admitted instead
  // of silently reporting no change.
  return computeConstituentChanges(currentTierModelIds, {
    basket_costs: previousTierIds.map((model_id) => ({ model_id })),
  } as Pick<Print, "basket_costs">);
}

export interface PublishInput extends Omit<PrintInput, "status"> {
  privateKeyHex: string;
  attestationClient?: AttestationClient;
  /** Refuse before signing or anchoring if the real spend for this print (every recorded
   * attempt across every registered model, per computeCostOfProduction) exceeds this — a
   * runaway-spend guard for unattended runs. Omit for manual publishing, where a human
   * already sees the cost before choosing to run at all. */
  spendCeilingUsd?: string;
  /** When supplied, writes data/runs/<print_id>/index.json — see publication.ts's
   * writeRunManifest. Optional so synthetic-fixture unit tests (no real runs/ directory on
   * disk) don't need one; both real CLI entry points (cli/publish.ts,
   * cli/publish-unattended.ts) always pass it. */
  runsDirPath?: string;
  /** Every failed attempt for this print_id before this one — the automated same-day retry's
   * disclosure (docs/methodology.md's Index governance, retry policy). Known before signing
   * (unlike superseded_by/anchor), so it's part of the signed body — see print.schema.json. */
  priorAttempts?: PriorAttempt[];
  /** Registry membership changes taking effect as of this print — see
   * computeConstituentChanges. Known before signing, so part of the signed body like
   * priorAttempts, not added after the fact like superseded_by/anchor. */
  constituentChanges?: ConstituentChange[];
  /** Which tier grade this print is — design-doc §4a's "grades, not refineries" segmentation.
   * Absent means the blended Dated SIU itself. Known before signing (decided before
   * computation starts, unlike superseded_by/anchor), so part of the signed body — see
   * print.schema.json. */
  series?: "frontier" | "commodity";
}

export interface PublishResult {
  print: Print;
  write: WritePrintResult;
  indexPath: string;
  anchor: AnchorResult;
}

/**
 * Every run record across every model, schema-validated. build1-spec.md §9 (P9): "must refuse
 * to publish if any run record fails schema validation." This is deliberately a separate,
 * explicit gate — computeClassCost's arithmetic would happily read a malformed record's
 * present fields and produce a wrong number silently, rather than an error. Schema validation
 * here catches what arithmetic alone would not.
 */
export function findInvalidRecords(input: Pick<PrintInput, "models">): InvalidRecordReport[] {
  const invalid: InvalidRecordReport[] = [];
  for (const model of input.models) {
    for (const record of model.records) {
      const result = validateRunRecord(record);
      if (!result.valid) {
        invalid.push({ model_id: model.model_id, run_id: record.run_id, errors: result.errors });
      }
    }
  }
  return invalid;
}

/**
 * The publication pipeline from computed run records through to a signed, anchored, written
 * print — build1-spec.md §7.
 *
 * Deliberately does NOT run the harness or ask for confirmation: those are money-spending and
 * interactive concerns that belong in the CLI layer, not in a function unit tests call
 * directly with synthetic data.
 *
 * Always publishes `status: "provisional"` — only reconciliation (a separate step, comparing
 * summed run costs against a real invoice) can promote a print to final. Nothing in this
 * function is capable of marking one final itself.
 */
export async function publishPrint(printsDir: string, input: PublishInput): Promise<PublishResult> {
  const invalid = findInvalidRecords(input);
  if (invalid.length > 0) {
    const detail = invalid
      .map((r) => `${r.model_id}/${r.run_id}: ${r.errors.join("; ")}`)
      .join("\n  ");
    throw new Error(
      `Refusing to publish: ${invalid.length} run record(s) failed schema validation:\n  ${detail}`,
    );
  }

  const { body } = computePrint({ ...input, status: "provisional" });

  // Refuse before signing or anchoring — a print below the floor should never spend anchor gas
  // or produce a signed artifact in the first place, not just fail some later review.
  const qualifying = [...body.basket_costs].filter((m) => m.cost_usd !== undefined).length;
  if (qualifying < MINIMUM_QUALIFYING_MODELS) {
    throw new QualifyingSetError(qualifying, body.basket_costs.length, body.cost_of_production_usd);
  }

  // Same "refuse before signing or anchoring" shape as the qualifying-set gate above — a
  // runaway-cost print should never spend anchor gas or produce a signed artifact either.
  if (input.spendCeilingUsd !== undefined) {
    const spent = computeCostOfProduction(input.models);
    if (spent.greaterThan(input.spendCeilingUsd)) {
      throw new Error(
        `Refusing to publish: cost of production $${spent.toString()} exceeds the configured ` +
          `ceiling of $${input.spendCeilingUsd}.`,
      );
    }
  }

  const bodyWithDisclosures = {
    ...body,
    ...(input.priorAttempts && input.priorAttempts.length > 0
      ? { prior_attempts: input.priorAttempts }
      : {}),
    ...(input.constituentChanges && input.constituentChanges.length > 0
      ? { constituent_changes: input.constituentChanges }
      : {}),
    ...(input.series ? { series: input.series } : {}),
  };
  const signed = signPrintBody(bodyWithDisclosures, input.privateKeyHex);

  const client = input.attestationClient ?? new StubAttestationClient();
  const anchor = await client.postPrint(printBodyHashHex(signed), signed.version);

  // A failed anchor is not a lesser publish, it's an unverifiable one — and once written,
  // the append-only guard on writePrint makes that permanent for this print_id. A human
  // running this manually would notice `anchor.status: "failed"` and choose not to commit
  // it; automation has no such human, so this refuses outright rather than writing a print
  // that claims verifiability it doesn't have.
  if (anchor.status === "failed") {
    throw new Error(
      `Refusing to publish: anchoring failed (${anchor.notes ?? "no further detail"}). ` +
        `Nothing was signed to disk or committed.`,
    );
  }

  const print: Print = { ...signed, anchor };

  // signPrintBody already validated `signed`; anchor is new since, so validate the final
  // object too rather than assume adding it can't have broken anything.
  const finalCheck = validatePrint(print);
  if (!finalCheck.valid) {
    throw new Error(
      `Refusing to publish: print failed schema validation after anchoring: ${finalCheck.errors.join("; ")}`,
    );
  }

  const write = await writePrint(printsDir, print);
  const indexPath = await writePrintsIndex(printsDir);

  if (input.runsDirPath !== undefined) {
    await writeRunManifest(
      input.runsDirPath,
      print,
      input.models.flatMap((m) => m.records),
    );
  }

  return { print, write, indexPath, anchor };
}
