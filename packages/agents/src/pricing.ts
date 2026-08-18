import { callCost } from "@touchstone/print";
import { D, roundHalfUp } from "@touchstone/sdk";

/**
 * No real print has been published in this environment yet (`data/prints/` is empty — the
 * harness has never been run for real against paid APIs; see docs/keys_needed_datum.md). A real
 * `usd_per_siu` exchange rate is therefore unavailable, and CLAUDE.md's first hard invariant
 * ("the print is computed from executed runs only") rules out fabricating one. This is a
 * clearly-labeled default rate for this demo's quotes — never presented as, or confused with, a
 * real published rate. Both sellers in `cli/demo.ts` quote this same rate — the SIU spread a
 * buyer sees between them comes only from the real cost difference between the two distinct
 * models they each run (see `estimatedCeiling` below), not from an artificial per-seller markup.
 * Everything else priced with it (the real OpenRouter call, its real token usage, its real
 * dollar cost from `@touchstone/print`'s `callCost` against the real price snapshot) is genuine.
 * See docs/demo.md.
 */
export const DEMO_ILLUSTRATIVE_USD_PER_SIU = "0.0500";

const SIU_DP = 6;

/** A rough, honestly-approximate token estimate (chars/4) used only to size a defensible
 * `max_tokens` ceiling before a real call is made — never billed directly. Real settlement
 * always prices the real post-call usage (`realizedCost` below). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface PriceSnapshotEntryPrices {
  price_in_usd_per_1m: string;
  price_out_usd_per_1m: string;
}

/** The SIU-denominated ceiling a seller quotes *before* doing any work: real per-token USD
 * prices from the price snapshot, applied to an estimated prompt size and a hard `maxTokens`
 * output budget the seller commits to enforcing. `rateUsdPerSiu` is the seller's own asking
 * price per SIU — two sellers quoting the *same* rate over their own real, different per-token
 * prices is exactly what "compare two sellers' quotes in SIU" (build1-spec.md §11) demonstrates:
 * the resulting SIU figures differ because the underlying real cost differs, not because of a
 * chosen rate. */
export function estimatedCeiling(
  promptText: string,
  maxTokens: number,
  prices: PriceSnapshotEntryPrices,
  rateUsdPerSiu: string,
): { siu: string; siuMax: string } {
  const inputEstimate = estimateTokens(promptText);
  // A conservative point estimate: half the output ceiling, since most trivial replies don't
  // use the full budget — siu_max (below) is what escrow actually holds against.
  const pointEstimateOutputTokens = Math.max(1, Math.floor(maxTokens / 2));

  const pointUsd = callCost(
    inputEstimate,
    pointEstimateOutputTokens,
    prices.price_in_usd_per_1m,
    prices.price_out_usd_per_1m,
  ).toString();
  const ceilingUsd = callCost(
    inputEstimate,
    maxTokens,
    prices.price_in_usd_per_1m,
    prices.price_out_usd_per_1m,
  ).toString();

  return {
    siu: roundHalfUp(new D(pointUsd).dividedBy(rateUsdPerSiu), SIU_DP),
    siuMax: roundHalfUp(new D(ceilingUsd).dividedBy(rateUsdPerSiu), SIU_DP),
  };
}

/** The real dollar cost of a real, already-completed call — what `settle()`'s `actualAmount`
 * is derived from. */
export function realizedCost(
  inputTokens: number,
  outputTokens: number,
  prices: PriceSnapshotEntryPrices,
): string {
  return callCost(
    inputTokens,
    outputTokens,
    prices.price_in_usd_per_1m,
    prices.price_out_usd_per_1m,
  ).toString();
}
