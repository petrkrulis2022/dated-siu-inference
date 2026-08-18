import { D, minorUnitsToUsd } from "@touchstone/sdk";
import type { EscrowLifecycle } from "./escrow-lifecycle.js";

export interface QuotedVsPaidRow {
  quoteHash: string;
  seller: string;
  buyer: string;
  amountQuotedUsd: string;
  amountPaidUsd: string;
  matched: boolean;
  settledAt: string;
  settledTx: string;
}

export interface QuotedVsPaidResult {
  rows: QuotedVsPaidRow[];
  unknownQuoteCount: number;
}

/**
 * The honest-seller check — "the thing verify_receipt exists to prove," made visible across all
 * activity at a glance. Uses the exact `matched` formula `docs/settlement-metadata.md` and
 * `verifyReceiptTool` already define (`amount_paid_usd ≤ amount_quoted_usd`, i.e.
 * `actualAmount ≤ maxAmount`) via `@touchstone/sdk`'s `minorUnitsToUsd`/`D` — arithmetic only. Does
 * NOT call `verifyReceiptTool` itself, which requires `TOUCHSTONE_PUBLISHER_KEY` to sign a receipt;
 * this read-only package must never hold or use a signing key.
 */
export function computeQuotedVsPaid(lifecycles: EscrowLifecycle[]): QuotedVsPaidResult {
  const settled = lifecycles.filter((l) => l.status === "settled" && l.actualAmount);
  const rows: QuotedVsPaidRow[] = [];
  let unknownQuoteCount = 0;

  for (const l of settled) {
    if (!l.quote) {
      unknownQuoteCount += 1;
      continue;
    }
    const matched = !new D(l.actualAmount!).greaterThan(l.maxAmount);
    rows.push({
      quoteHash: l.quoteHash,
      seller: l.seller,
      buyer: l.buyer,
      amountQuotedUsd: minorUnitsToUsd(l.maxAmount),
      amountPaidUsd: minorUnitsToUsd(l.actualAmount!),
      matched,
      settledAt: l.settledAt!,
      settledTx: l.settledTx!,
    });
  }

  return { rows, unknownQuoteCount };
}
