import { validateRunRecord, validatePrint, type Print } from "@touchstone/sdk";
import { computePrint, type PrintInput } from "./compute/index.js";
import { signPrintBody } from "./sign/sign.js";
import { printBodyHashHex } from "./sign/canonicalise.js";
import { writePrint, writePrintsIndex, type WritePrintResult } from "./publication.js";
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

export interface PublishInput extends Omit<PrintInput, "status"> {
  privateKeyHex: string;
  attestationClient?: AttestationClient;
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
    throw new Error(
      `Refusing to publish: only ${qualifying} of ${body.basket_costs.length} registered ` +
        `models qualified (minimum ${MINIMUM_QUALIFYING_MODELS}) — this reference set is too ` +
        `thin to constitute a print, not merely a worse measurement of the usual one. See ` +
        `methodology.md's registry inclusion policy.`,
    );
  }

  const signed = signPrintBody(body, input.privateKeyHex);

  const client = input.attestationClient ?? new StubAttestationClient();
  const anchor = await client.postPrint(printBodyHashHex(signed), signed.version);
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

  return { print, write, indexPath, anchor };
}
