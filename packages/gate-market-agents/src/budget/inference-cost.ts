import { callCost } from "@touchstone/print";
import { D } from "@touchstone/sdk";

/** Real per-token USD prices — same shape `packages/agents/src/pricing.ts`'s
 * `PriceSnapshotEntryPrices` already uses, matching `data/registry/price-snapshot-merged-*.json`'s
 * real fields. Not duplicated as an import (that type lives in the demo package, a different
 * concern); this package reads the same real snapshot shape independently. */
export interface ModelPrices {
  priceInUsdPer1M: string;
  priceOutUsdPer1M: string;
}

/** A rough, honestly-approximate token estimate (chars/4) — the same heuristic
 * `packages/agents/src/pricing.ts`'s `estimateTokens` already uses, reused here rather than
 * reinvented. Only ever used to size a defensible ceiling before a real call; never billed
 * directly. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * The worst-case dollar cost of one turn, checked *before* the call — spec §12.2a: "projected
 * inference cost from the chosen reasoning_model against that agent's inference_ceiling_usd."
 * Deliberately the full `maxOutputTokens` (not a point estimate like
 * `packages/agents/src/pricing.ts`'s `estimatedCeiling` uses for its `siu` field) — this gates a
 * hard ceiling before spend happens, so it must bound the true worst case, not a typical case.
 * Built directly on `@touchstone/print`'s `callCost` (`packages/print/src/decimal.ts`) — the
 * same real, decimal-string cost function this repo's main product already uses, not
 * reimplemented. `cachedTokens`/`cachedPricePerMillion` pass straight through, since `callCost`
 * already supports cached-token pricing.
 */
export function projectedTurnCostUsd(
  contextTokens: number,
  maxOutputTokens: number,
  prices: ModelPrices,
  cachedTokens = 0,
  cachedPricePerMillion?: string,
): string {
  return callCost(
    contextTokens,
    maxOutputTokens,
    prices.priceInUsdPer1M,
    prices.priceOutUsdPer1M,
    cachedTokens,
    cachedPricePerMillion,
  ).toString();
}

/** The real dollar cost of a real, already-completed call — mirrors
 * `packages/agents/src/pricing.ts`'s `realizedCost`, for the post-call true-up once a real turn
 * loop knows the real token usage. */
export function realizedTurnCostUsd(
  inputTokens: number,
  outputTokens: number,
  prices: ModelPrices,
  cachedTokens = 0,
  cachedPricePerMillion?: string,
): string {
  return callCost(
    inputTokens,
    outputTokens,
    prices.priceInUsdPer1M,
    prices.priceOutUsdPer1M,
    cachedTokens,
    cachedPricePerMillion,
  ).toString();
}

/** `true` if `usdAmount` is exactly `"0"` — `BudgetCeiling.recordInferenceSpend` skips the
 * ceiling check entirely for a literal zero rather than doing decimal-string comparison work for
 * the common "nothing to charge" case. */
export function isZeroUsd(usdAmount: string): boolean {
  return new D(usdAmount).isZero();
}
