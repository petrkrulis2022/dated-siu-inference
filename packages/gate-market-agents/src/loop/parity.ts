/**
 * Price parity between the two ways of settling a quote.
 *
 * **Why this exists.** A quote states a size (`siu`) and a price (`settlement[0].amount_max`, in
 * USDC minor units). Settling in USDC pays the price. Settling in fSIU used to pay the SIU count —
 * `quote.siu` converted to milli-SIU — which is the same dollars only if the quote's rate happened
 * to equal the print. Nothing made it so: the buyer types the rate into `request_quote`. A quote
 * at $0.05 per SIU against a $0.0107 print cost $0.50 in USDC and about $0.107 in fSIU, and an
 * agent choosing the second was choosing a 79% discount — so F1 would have measured which asset
 * is cheaper, not which one agents prefer.
 *
 * **The rule.** An fSIU settlement is sized so the claim is worth the quote's USDC price at the
 * print in force: `claim = ceil(price / print)`, in integers throughout (invariant 4). Rounding up
 * means the seller is never short, and the payer overpays by strictly less than the value of one
 * milli-SIU at the print — about $0.0000014 at the 2026-10-03 print. The USDC price is itself
 * rounded to four decimals by the quote format; parity is to that stated price.
 *
 * The "print in force" is the one the quote names (`print_id`) and must be the one this window
 * attests: a quote from another print cannot be sized here, and is refused rather than converted at
 * a rate it was not issued against.
 */
import type { TouchstoneQuote } from "@touchstone/sdk";
import { claimValueMinorUnits } from "../tools/settle-split.js";

export interface PrintInForce {
  printId: string;
  /** nanoUSD per SIU, as attested for this window's mints. */
  nanoUsdPerSiu: bigint;
}

/** Milli-SIU of claim worth the quote's USDC price at `print`, rounded up. */
export function claimMilliSiuForQuote(
  quote: Pick<TouchstoneQuote, "print_id" | "settlement">,
  print: PrintInForce,
): bigint {
  if (quote.print_id !== print.printId) {
    throw new Error(
      `this quote was issued against print "${quote.print_id}", but the print in force for this ` +
        `window is "${print.printId}". A claim is sized at the print the quote was issued ` +
        "against, so a quote from another print cannot be settled in claims here.",
    );
  }
  if (print.nanoUsdPerSiu <= 0n) throw new Error("the print rate for this window is not positive.");
  const priceMinorUnits = BigInt(quote.settlement[0].amount_max);
  if (priceMinorUnits <= 0n) throw new Error("this quote states no price, so a claim cannot be sized from it.");
  return (priceMinorUnits * 1_000_000n + print.nanoUsdPerSiu - 1n) / print.nanoUsdPerSiu;
}

/**
 * What `WorkClaim.mint` charges, in USDC minor units, to mint `milliSiu` at `nanoUsdPerSiu` —
 * the contract's own formula, shared with `settle_split`'s claim leg so there is one definition.
 */
export function claimMintCostMinorUnits(milliSiu: bigint, nanoUsdPerSiu: bigint): bigint {
  return claimValueMinorUnits(milliSiu.toString(), nanoUsdPerSiu.toString());
}
