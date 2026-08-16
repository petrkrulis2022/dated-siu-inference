import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import { D, roundHalfUp, usdToMinorUnits, usdcAddressFor } from "../money/index.js";

/** Build-1's fixed convention for amount_usd_max's precision — matches build1-spec.md §8's own
 * illustrative example (siu_max 1.400 × rate 0.0483 = 0.06762, rounded half-up to 4dp = 0.0676)
 * and print's usd_per_siu_dp default. `quote/validate.ts` reconciles against the same constant. */
export const QUOTE_AMOUNT_DP = 4;

/**
 * The smallest nonzero value representable at `QUOTE_AMOUNT_DP`'s precision — docs/datum-quote.md's
 * "Minimum quotable amount". Below this, `amount_usd_max` rounds to `"0.0000"` and
 * `DatumEscrow.openAndFund` reverts on a zero `maxAmount` — hit live in P14's demo agents.
 * Computed from `QUOTE_AMOUNT_DP` rather than hand-typed again, so the two can never drift.
 */
export const MINIMUM_QUOTABLE_USD = roundHalfUp(
  new D(1).dividedBy(new D(10).pow(QUOTE_AMOUNT_DP)),
  QUOTE_AMOUNT_DP,
);

/**
 * Bumped from "1.0" when the optional `settler` field was added alongside `DatumEscrow`
 * (build1-spec.md §10). A minor bump is the correct signal: the field is purely additive, and
 * `validateQuote`'s major-version check still accepts it. A 1.0-era consumer holding the old
 * schema will reject a quote carrying `settler` because the schema is `additionalProperties:
 * false` — which is why the version has to move, so the rejection is explicable rather than
 * mysterious.
 */
export const QUOTE_SCHEMA_VERSION = "1.1";

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
  /**
   * Optional address the buyer additionally authorises to call `DatumEscrow.settle`. Omit for
   * seller-only settlement. Carried on the quote so the seller can compare it against the
   * on-chain `settlerOf(quoteHash)` before doing any work — a buyer who funds escrow naming a
   * different settler than the signed quote agreed could otherwise settle at zero after
   * receiving the completed work. docs/datum-quote.md makes that check normative.
   */
  settler?: string;
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
  // Omitted entirely rather than set to the zero address when absent: the schema treats an
  // absent settler as seller-only, and an explicit 0x000…0 would be a different claim requiring
  // its own validation.
  if (input.settler !== undefined) {
    body.settler = input.settler;
  }
  return body;
}
