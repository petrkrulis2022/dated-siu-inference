import { D, type TouchstoneQuote } from "@touchstone/sdk";
import type { EventCache } from "../indexer/cache.js";

export interface QuotedInfo {
  siu: string;
  model: string;
  printId: string;
}

export interface EscrowLifecycle {
  quoteHash: string;
  buyer: string;
  seller: string;
  settler: string;
  maxAmount: string;
  status: "open" | "settled" | "expired";
  openedAt: string;
  openedTx: string;
  expiryUnix: string;
  actualAmount?: string;
  feeAmount?: string;
  sellerReceived?: string;
  buyerRefund?: string;
  receiptRef?: string;
  settledAt?: string;
  settledTx?: string;
  expiredAt?: string;
  expiredTx?: string;
  /** `null` when no local quote is known for this quoteHash — a common, non-error state (see
   * `quotes/local-quotes.ts`), never omitted so the UI can render "quote unknown" explicitly. */
  quote: QuotedInfo | null;
}

const BPS_DENOMINATOR = 10_000;

/**
 * Reconstructs every escrow's full lifecycle from the indexer's decoded events — pure, no I/O,
 * so it's directly unit-testable. `status` is derived from which terminal event (if any) exists
 * for a `quoteHash`: `Settled` and `Expired` are mutually exclusive by contract construction
 * (`TouchstoneEscrow.sol`'s `settle`/`expire` require `Status.Open`, and each sets a terminal status),
 * so at most one of them is ever present for a given quoteHash; neither present means still open.
 */
export function reconstructEscrowLifecycles(
  events: EventCache["events"],
  feeBps: string,
  localQuotes: Map<string, TouchstoneQuote>,
): EscrowLifecycle[] {
  const settledByHash = new Map(events.settled.map((e) => [e.quoteHash.toLowerCase(), e]));
  const expiredByHash = new Map(events.expired.map((e) => [e.quoteHash.toLowerCase(), e]));

  return events.opened.map((opened) => {
    const key = opened.quoteHash.toLowerCase();
    const settled = settledByHash.get(key);
    const expired = expiredByHash.get(key);
    const localQuote = localQuotes.get(key) ?? null;

    const base: EscrowLifecycle = {
      quoteHash: opened.quoteHash,
      buyer: opened.buyer,
      seller: opened.seller,
      settler: opened.settler,
      maxAmount: opened.maxAmount,
      status: "open",
      openedAt: opened.timestamp,
      openedTx: opened.txHash,
      expiryUnix: opened.expiry,
      quote: localQuote
        ? { siu: localQuote.siu, model: localQuote.model, printId: localQuote.print_id }
        : null,
    };

    if (settled) {
      const actual = new D(settled.actualAmount);
      const fee = actual.times(feeBps).dividedBy(BPS_DENOMINATOR).toFixed(0, D.ROUND_DOWN);
      const sellerReceived = actual.minus(fee).toFixed(0);
      const buyerRefund = new D(opened.maxAmount).minus(actual).toFixed(0);
      return {
        ...base,
        status: "settled",
        actualAmount: settled.actualAmount,
        feeAmount: fee,
        sellerReceived,
        buyerRefund,
        receiptRef: settled.receiptRef,
        settledAt: settled.timestamp,
        settledTx: settled.txHash,
      };
    }

    if (expired) {
      return {
        ...base,
        status: "expired",
        buyerRefund: expired.amount,
        expiredAt: expired.timestamp,
        expiredTx: expired.txHash,
      };
    }

    return base;
  });
}

export interface ActivityAggregates {
  totalUsdcSettledMinorUnits: string;
  totalSiuTransacted: string;
  byBuyer: Record<string, { count: number; volumeMinorUnits: string }>;
  bySeller: Record<string, { count: number; volumeMinorUnits: string }>;
}

/** Pure aggregation over already-reconstructed lifecycles — settled escrows only, since those
 * are the only ones with a real `actualAmount` (an open or expired escrow moved no work). */
export function computeActivityAggregates(lifecycles: EscrowLifecycle[]): ActivityAggregates {
  const settled = lifecycles.filter((l) => l.status === "settled" && l.actualAmount);

  let totalUsdc = new D(0);
  let totalSiu = new D(0);
  const byBuyer: Record<string, { count: number; volumeMinorUnits: string }> = {};
  const bySeller: Record<string, { count: number; volumeMinorUnits: string }> = {};

  for (const l of settled) {
    const amount = new D(l.actualAmount!);
    totalUsdc = totalUsdc.plus(amount);
    if (l.quote) {
      totalSiu = totalSiu.plus(l.quote.siu);
    }

    const buyerEntry = byBuyer[l.buyer] ?? { count: 0, volumeMinorUnits: "0" };
    buyerEntry.count += 1;
    buyerEntry.volumeMinorUnits = new D(buyerEntry.volumeMinorUnits).plus(amount).toFixed(0);
    byBuyer[l.buyer] = buyerEntry;

    const sellerEntry = bySeller[l.seller] ?? { count: 0, volumeMinorUnits: "0" };
    sellerEntry.count += 1;
    sellerEntry.volumeMinorUnits = new D(sellerEntry.volumeMinorUnits).plus(amount).toFixed(0);
    bySeller[l.seller] = sellerEntry;
  }

  return {
    totalUsdcSettledMinorUnits: totalUsdc.toFixed(0),
    totalSiuTransacted: totalSiu.toString(),
    byBuyer,
    bySeller,
  };
}
