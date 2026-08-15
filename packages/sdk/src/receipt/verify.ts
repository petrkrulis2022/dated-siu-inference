import type { Receipt } from "../types/generated/receipt.schema.js";
import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import { D } from "../money/index.js";
import { quoteHashHex } from "../quote/sign.js";
import { verifyReceiptSignature } from "./sign.js";

export interface VerifyReceiptOptions {
  publicKeyHex: string;
  /** If supplied, checks receipt.quote_hash against this quote's own hash — binding the
   * receipt to the specific offer it claims to settle. */
  quote?: DatumQuote;
}

export interface ReceiptVerification {
  valid: boolean;
  reasons: string[];
}

/**
 * `get_index`'s sibling on the receipt side (build1-spec.md §9): quoted vs paid vs matched,
 * checked rather than trusted. Three independent checks, all of which must pass:
 *
 * 1. The signature verifies (proves the receipt wasn't tampered with after Datum signed it).
 * 2. `matched` is honest: it must equal `amount_paid_usd ≤ amount_quoted_usd`
 *    (build1-spec.md §10's escrow invariant `actualAmount ≤ maxAmount`, restated in dollar
 *    terms). A receipt claiming `matched: true` while its own figures show an overspend is
 *    rejected outright, not passed through.
 * 3. If a quote is supplied, `quote_hash` binds to that specific quote — a receipt cannot be
 *    replayed against an unrelated offer.
 */
export function verifyReceipt(
  receipt: Receipt,
  options: VerifyReceiptOptions,
): ReceiptVerification {
  const reasons: string[] = [];

  const sigCheck = verifyReceiptSignature(receipt, options.publicKeyHex);
  if (!sigCheck.valid) {
    reasons.push(`signature invalid: ${sigCheck.reason ?? "unknown"}`);
  }

  const withinQuotedAmount = !new D(receipt.amount_paid_usd).greaterThan(receipt.amount_quoted_usd);
  if (receipt.matched !== withinQuotedAmount) {
    reasons.push(
      `matched=${receipt.matched} disagrees with amount_paid_usd (${receipt.amount_paid_usd}) ` +
        `vs amount_quoted_usd (${receipt.amount_quoted_usd}) — a receipt's matched flag must ` +
        `not contradict its own figures`,
    );
  }

  if (options.quote) {
    const expectedHash = quoteHashHex(options.quote);
    if (receipt.quote_hash.toLowerCase() !== expectedHash.toLowerCase()) {
      reasons.push(
        `quote_hash (${receipt.quote_hash}) does not match the supplied quote's hash (${expectedHash})`,
      );
    }
  }

  return { valid: reasons.length === 0, reasons };
}
