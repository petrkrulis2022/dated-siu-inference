import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import { D, roundHalfUp, usdToMinorUnits, usdcAddressFor } from "../money/index.js";

/** Build-1's fixed convention for amount_usd_max's precision — matches build1-spec.md §8's own
 * illustrative example (siu_max 1.400 × rate 0.0483 = 0.06762, rounded half-up to 4dp = 0.0676)
 * and print's usd_per_siu_dp default. `quote/validate.ts` reconciles against the same constant. */
export const QUOTE_AMOUNT_DP = 4;

export const QUOTE_SCHEMA_VERSION = "1.0";

export type QuoteBody = Omit<DatumQuote, "sig">;

interface QuoteBuildInputBase {
  siu: string;
  model: string;
  rateUsdPerSiu: string;
  indexVersion: string;
  printId: string;
  printHash: string;
  sellerId: string;
  /** Build 1 permits exactly one settlement entry and it must be USDC — see quote/validate.ts. */
  chain: string;
  expiresInSeconds: number;
  now?: Date;
}

/**
 * A discriminated union closing, at compile time, the gap the generated `DatumQuote` type
 * leaves open: the schema's `if pattern in [estimate, cap] then required: siu_max` is invisible
 * to json-schema-to-typescript's output (`siu_max` is just optional there), so nothing stops a
 * caller of the raw type from building an unbounded estimate. A caller who goes through
 * `buildQuoteBody` cannot omit `siuMax` for `estimate`/`cap` without a type error. Data that
 * arrives over the wire, already JSON, gets no benefit from this — `quote/mandate.ts`'s runtime
 * check exists precisely for that case.
 */
export type QuoteBuildInput =
  | (QuoteBuildInputBase & { pattern: "fixed" })
  | (QuoteBuildInputBase & { pattern: "estimate"; siuMax: string })
  | (QuoteBuildInputBase & { pattern: "cap"; siuMax: string });

/**
 * Builds an unsigned quote body — build1-spec.md §8. `signQuote` (quote/sign.ts) turns this
 * into a signed `DatumQuote`.
 *
 * `amount_usd_max` is computed from `siu_max` when the pattern has one (`estimate`/`cap`),
 * never from the point-estimate `siu` — escrow must hold enough to cover the worst case the
 * quote allows, not the seller's best guess. For `fixed`, there is no `siu_max`, so the
 * committed `siu` figure is what's owed and what escrow holds against.
 */
export function buildQuoteBody(input: QuoteBuildInput): QuoteBody {
  const siuForAmount = input.pattern === "fixed" ? input.siu : input.siuMax;
  const amountUsdMax = roundHalfUp(new D(siuForAmount).times(input.rateUsdPerSiu), QUOTE_AMOUNT_DP);

  const address = usdcAddressFor(input.chain);
  if (!address) {
    throw new Error(
      `No known USDC address for chain "${input.chain}" — refusing to build a quote whose ` +
        `settlement entry would point nowhere. See money/assets.ts.`,
    );
  }

  const now = input.now ?? new Date();
  const expiry = new Date(now.getTime() + input.expiresInSeconds * 1000).toISOString();

  const body: QuoteBody = {
    schema_version: QUOTE_SCHEMA_VERSION,
    siu: input.siu,
    pattern: input.pattern,
    model: input.model,
    rate_usd_per_siu: input.rateUsdPerSiu,
    amount_usd_max: amountUsdMax,
    index_version: input.indexVersion,
    print_id: input.printId,
    print_hash: input.printHash,
    seller_id: input.sellerId,
    expiry,
    settlement: [
      {
        asset: "usdc",
        chain: input.chain,
        address,
        amount_max: usdToMinorUnits(amountUsdMax),
      },
    ],
  };
  if (input.pattern !== "fixed") {
    body.siu_max = input.siuMax;
  }
  return body;
}
