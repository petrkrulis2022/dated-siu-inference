import type { Print } from "@touchstone/sdk";
import { validatePrint } from "@touchstone/sdk";
import { computePrint, type PrintInput } from "./compute/index.js";
import { canonicalise, printBodyOf } from "./sign/canonicalise.js";
import { verifyPrintSignature } from "./sign/sign.js";

export interface Discrepancy {
  field: string;
  published: string;
  recomputed: string;
}

export interface VerifyResult {
  ok: boolean;
  schemaValid: boolean;
  schemaErrors?: string[];
  signatureValid: boolean;
  signatureReason?: string;
  bodyHash: string;
  /** Only populated when recomputation inputs were supplied. */
  recomputed?: boolean;
  discrepancies: Discrepancy[];
}

function compare(
  field: string,
  published: string | undefined,
  recomputed: string | undefined,
  out: Discrepancy[],
): void {
  const p = published ?? "(absent)";
  const r = recomputed ?? "(absent)";
  if (p !== r) {
    out.push({ field, published: p, recomputed: r });
  }
}

/**
 * Re-checks a published print — build1-spec.md §6: "a verify command that re-checks any
 * published print's signature and recomputes it from stored runs and the referenced snapshot."
 *
 * Two independent checks:
 *  1. The signature covers the published body (detects tampering after publication).
 *  2. Recomputing from the stored runs and referenced price snapshot reproduces the published
 *     figures (detects a print that was signed correctly but computed wrongly — the failure a
 *     signature alone cannot catch).
 *
 * `input` is optional so a third party holding only the print file can still check the
 * signature; the recomputation needs the run records, which live alongside it in data/runs.
 */
export function verifyPrint(print: Print, input?: PrintInput): VerifyResult {
  const schema = validatePrint(print);
  const signature = verifyPrintSignature(print);
  const discrepancies: Discrepancy[] = [];

  if (!input) {
    return {
      ok: schema.valid && signature.valid,
      schemaValid: schema.valid,
      schemaErrors: schema.valid ? undefined : schema.errors,
      signatureValid: signature.valid,
      signatureReason: signature.reason,
      bodyHash: signature.bodyHash,
      discrepancies,
    };
  }

  const { body } = computePrint(input);

  compare("dated_siu", print.dated_siu, body.dated_siu, discrepancies);
  compare("weights.source", print.weights.source, body.weights.source, discrepancies);
  compare("market_spread", print.market_spread, body.market_spread, discrepancies);

  // Spread before mapping: these arrays are `minItems: 1` in the schema, so the generated
  // type is a tuple ([T, ...T[]]) and .map() on it loses the element type.
  const publishedBaskets = new Map([...print.basket_costs].map((r) => [r.model_id, r.cost_usd]));
  for (const row of [...body.basket_costs]) {
    compare(
      `basket_costs[${row.model_id}]`,
      publishedBaskets.get(row.model_id),
      row.cost_usd,
      discrepancies,
    );
  }

  const publishedRates = new Map([...print.exchange_rate_table].map((r) => [r.model_id, r]));
  for (const row of [...body.exchange_rate_table]) {
    const published = publishedRates.get(row.model_id);
    compare(
      `exchange_rate_table[${row.model_id}].usd_per_siu`,
      published?.usd_per_siu,
      row.usd_per_siu,
      discrepancies,
    );
    compare(
      `exchange_rate_table[${row.model_id}].spread_to_index`,
      published?.spread_to_index,
      row.spread_to_index,
      discrepancies,
    );
    compare(
      `exchange_rate_table[${row.model_id}].siu_per_usd`,
      published?.siu_per_usd,
      row.siu_per_usd,
      discrepancies,
    );
  }

  const publishedWeights = new Map([...print.weights.values].map((w) => [w.model_id, w.weight]));
  for (const w of [...body.weights.values]) {
    compare(`weights[${w.model_id}]`, publishedWeights.get(w.model_id), w.weight, discrepancies);
  }

  // A model present in one and absent from the other is itself a discrepancy, and the loops
  // above only walk the recomputed side.
  for (const row of [...print.basket_costs]) {
    if (![...body.basket_costs].some((r) => r.model_id === row.model_id)) {
      discrepancies.push({
        field: `basket_costs[${row.model_id}]`,
        published: row.cost_usd ?? "(excluded)",
        recomputed: "(model absent from recomputation)",
      });
    }
  }

  return {
    ok: schema.valid && signature.valid && discrepancies.length === 0,
    schemaValid: schema.valid,
    schemaErrors: schema.valid ? undefined : schema.errors,
    signatureValid: signature.valid,
    signatureReason: signature.reason,
    bodyHash: signature.bodyHash,
    recomputed: true,
    discrepancies,
  };
}

export function formatVerifyReport(print: Print, result: VerifyResult): string {
  const lines = [
    `Print ${print.print_id} (${print.version}, ${print.status})`,
    `  Schema:    ${result.schemaValid ? "valid" : `INVALID — ${result.schemaErrors?.join("; ")}`}`,
    `  Body hash: ${result.bodyHash}`,
    `  Signature: ${result.signatureValid ? "valid" : `INVALID — ${result.signatureReason}`}`,
  ];

  if (result.recomputed) {
    if (result.discrepancies.length === 0) {
      lines.push("  Recompute: matches the published figures exactly");
    } else {
      lines.push(`  Recompute: ${result.discrepancies.length} DISCREPANCY(S)`);
      for (const d of result.discrepancies) {
        lines.push(`    ${d.field}: published ${d.published}, recomputed ${d.recomputed}`);
      }
    }
  } else {
    lines.push("  Recompute: skipped (no run records supplied — signature checked only)");
  }

  lines.push(`  Result: ${result.ok ? "OK" : "FAILED"}`);
  return lines.join("\n");
}

/** The exact bytes a signature covers — useful for anyone reimplementing the check. */
export function canonicalBody(print: Print): string {
  return canonicalise(printBodyOf(print));
}
