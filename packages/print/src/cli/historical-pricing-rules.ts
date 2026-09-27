/**
 * Which cost-formula rules actually applied to a print, keyed by its own real date — the same
 * role `rounding` plays for rounding rules (see cli/verify-support.ts, docs/methodology.md's
 * Rounding section), except neither of these two rules was ever recorded as an explicit field
 * on the print itself, so there is nothing to read off the print directly; the effective dates
 * below are the real, empirically-confirmed boundaries (packages/print/src/cli/verify-all.ts's
 * own real recompute sweep across all 84 published prints, 2026-09-26), not a guess from the
 * commit messages alone — methodology.md's own Revision history table states a slightly
 * optimistic effective date for rules-2026-09-25b (2026-09-25) that this deliberately does not
 * repeat, because the 2026-09-25 print itself still recomputes as cached-input-unpriced.
 *
 * Used only by verify (cli/verify-support.ts) to reconstruct what a historical print's own
 * recomputation should look like — the production print pipeline never consults this; it always
 * prices under today's real rules.
 */
export interface HistoricalPricingRules {
  /** Whether usage.reasoning was priced (folded into output, at the output rate) — see
   * class-cost.ts's own doc comment. False for every print dated on or before 2026-09-08 (the
   * day the gap was found; the fix "applies forward from the next published print onward", per
   * that print's own correction note). */
  reasoningTokensPriced: boolean;
  /** Whether usage.cached_input was priced against a snapshot's own published cached rate.
   * False for every print from 2026-09-14 (buildModelInputs never forwarded the rate before
   * this) through 2026-09-25 inclusive — the fix (commit 327d7b9) landed live on 2026-09-25
   * itself, but that day's own print had already been computed under the old, unpriced
   * behaviour; 2026-09-26 is the first real print that benefits. */
  cachedInputPriced: boolean;
}

const REASONING_TOKEN_PRICING_EFFECTIVE_DATE = "2026-09-09";
const CACHED_INPUT_PRICING_EFFECTIVE_DATE = "2026-09-26";

export function historicalPricingRulesFor(date: string): HistoricalPricingRules {
  return {
    reasoningTokensPriced: date >= REASONING_TOKEN_PRICING_EFFECTIVE_DATE,
    cachedInputPriced: date >= CACHED_INPUT_PRICING_EFFECTIVE_DATE,
  };
}
