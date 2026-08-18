import { D, type TouchstoneQuote } from "@touchstone/sdk";

/**
 * "Payment amounts are dollar-fixed; SIU is the comparison unit" (docs/datum-quote.md) — a buyer
 * comparing two sellers compares their `siu` figures, not `amount_usd_max` directly, because SIU
 * is the unit the two sellers' independent dollar rates are otherwise incommensurable against.
 */
export function pickCheaperQuote(a: TouchstoneQuote, b: TouchstoneQuote): TouchstoneQuote {
  return new D(a.siu).lessThanOrEqualTo(b.siu) ? a : b;
}
