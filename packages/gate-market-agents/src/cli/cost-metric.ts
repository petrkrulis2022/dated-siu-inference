/**
 * Cost per delivered SIU, built from what was SETTLED — never from a quote's ceiling — and giving
 * fSIU a dollar figure instead of leaving it out.
 *
 * **Why both assets get a figure.** A metric that prices only the dollar route describes the
 * minority asset and says nothing about the other. fSIU has a dollar cost: what the claim cost to
 * mint, read from the mint receipt's own USDC transfer. The print-equivalent — the claim's
 * quantity at the print — sits beside it, because the two differ whenever a claim was minted at
 * another rate than the one it is valued at, and the gap is itself information.
 *
 * **What each figure is.**
 *   - USDC: the amount the seller actually settled (a seller may claim less than the ceiling and
 *     the rest returns to the payer), joined to the payment by the quote's request id. An escrow
 *     nobody settled has no settled amount and is counted apart, not priced at its ceiling.
 *   - fSIU minted for the payment (`pay_with_claim`): the mint cost of that claim.
 *   - fSIU passed on (a keyed `transfer_claim`): the claim's ORIGINAL mint cost, pro rata by
 *     quantity. That is not what *this* payer paid — it received the claim — and is labelled so.
 *   - A split is its own row: its claim leg's mint cost plus its dollar leg's settled amount.
 *
 * Integer minor units throughout (invariant 4); SIU and the print are decimals via the SDK's
 * decimal type. Window 1 and delivered work only: a payment in a window where the work was not
 * delivered is counted and set aside, not priced.
 */
import { D } from "@touchstone/sdk";

const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

export interface CostMoment {
  agentId: string;
  turn: number;
  tool: string;
  asset: "usdc" | "fsiu" | "split";
  requestId?: string;
  quotedSiu?: string;
}
export interface CostEvent {
  kind: string;
  agentId?: string;
  turn?: number;
  tokenId?: string;
  quantityMilliSiu?: string;
  mintCostMinorUnits?: string;
  settlesRequestId?: string;
}
export interface CostSettlement {
  requestId: string;
  settledMinorUnits: string;
  quotedMinorUnits: string;
}
/** One run's window 1, with the facts the metric reads. */
export interface CostRun {
  gateDelivered?: boolean;
  paymentMoments?: readonly CostMoment[];
  usdcSettlements?: readonly CostSettlement[];
  capacityEvents: readonly CostEvent[];
  /** The print the run used, decimal USD per SIU. */
  printRateUsdPerSiu: string;
}

export interface AssetCost {
  payments: number;
  quotedSiu: string;
  /** USD, six decimals. */
  usd: string;
  usdPerSiu: string | null;
}
export interface BlockCost {
  usdc: AssetCost & { escrowNeverSettled: number; settledBelowQuoted: number };
  fsiu: AssetCost & {
    /** Σ claim quantity × the print, six decimals — the value at the print, beside the cost. */
    printEquivalentUsd: string;
    printEquivalentUsdPerSiu: string | null;
    /** Payments made by passing a claim on, carried at its original mint cost. */
    carriedAtOriginalMintCost: number;
  };
  split: AssetCost;
  paymentsInUndeliveredWindows: number;
  paymentsWithoutQuote: number;
  /** Payments whose claim or settlement could not be found in the recorded events. A nonzero
   *  count means the figures above omit them, and is a defect in the record, never a zero cost. */
  unmatched: number;
}

const usdOf = (minor: bigint): string => new D(minor.toString()).dividedBy(1_000_000).toFixed(6);
const perSiu = (usdMinor: bigint, siu: InstanceType<typeof D>): string | null =>
  siu.isZero() ? null : new D(usdMinor.toString()).dividedBy(1_000_000).dividedBy(siu).toFixed(6);

export function costOfRuns(runs: readonly CostRun[]): BlockCost {
  const acc = {
    usdc: { payments: 0, siu: new D(0), minor: 0n, never: 0, below: 0 },
    fsiu: { payments: 0, siu: new D(0), minor: 0n, printEq: new D(0), carried: 0 },
    split: { payments: 0, siu: new D(0), minor: 0n },
    undelivered: 0,
    noQuote: 0,
    unmatched: 0,
  };
  for (const run of runs) {
    const events = run.capacityEvents;
    const settlements = new Map((run.usdcSettlements ?? []).map((s) => [s.requestId, s]));
    // Total quantity and cost minted per token, so a claim passed on can be carried at its cost.
    const minted = new Map<string, { qty: bigint; cost: bigint }>();
    for (const e of events) {
      if (!MINT_KINDS.has(e.kind) || e.tokenId === undefined) continue;
      const m = minted.get(e.tokenId) ?? { qty: 0n, cost: 0n };
      m.qty += BigInt(e.quantityMilliSiu ?? "0");
      m.cost += BigInt(e.mintCostMinorUnits ?? "0");
      minted.set(e.tokenId, m);
    }
    const eventFor = (m: CostMoment, kind: string): CostEvent | undefined =>
      events.find(
        (e) => e.kind === kind && e.agentId === m.agentId && e.turn === m.turn && e.settlesRequestId === m.requestId,
      );

    for (const m of run.paymentMoments ?? []) {
      if (m.quotedSiu === undefined) {
        acc.noQuote += 1;
        continue;
      }
      if (run.gateDelivered !== true) {
        acc.undelivered += 1;
        continue;
      }
      const siu = new D(m.quotedSiu);
      if (m.asset === "usdc") {
        const s = m.requestId === undefined ? undefined : settlements.get(m.requestId);
        if (!s) {
          acc.usdc.never += 1;
          continue;
        }
        acc.usdc.payments += 1;
        acc.usdc.siu = acc.usdc.siu.plus(siu);
        acc.usdc.minor += BigInt(s.settledMinorUnits);
        if (BigInt(s.settledMinorUnits) < BigInt(s.quotedMinorUnits)) acc.usdc.below += 1;
      } else if (m.asset === "fsiu") {
        let cost: bigint | undefined;
        let qty: bigint | undefined;
        if (m.tool === "pay_with_claim") {
          const e = eventFor(m, "pay_with_claim");
          if (e?.mintCostMinorUnits !== undefined && e.quantityMilliSiu !== undefined) {
            cost = BigInt(e.mintCostMinorUnits);
            qty = BigInt(e.quantityMilliSiu);
          }
        } else if (m.tool === "transfer_claim") {
          const e = eventFor(m, "transfer_claim");
          const origin = e?.tokenId === undefined ? undefined : minted.get(e.tokenId);
          if (e?.quantityMilliSiu !== undefined && origin !== undefined && origin.qty > 0n) {
            qty = BigInt(e.quantityMilliSiu);
            cost = (origin.cost * qty) / origin.qty; // pro rata, rounded down
            acc.fsiu.carried += 1;
          }
        }
        if (cost === undefined || qty === undefined) {
          acc.unmatched += 1;
          continue;
        }
        acc.fsiu.payments += 1;
        acc.fsiu.siu = acc.fsiu.siu.plus(siu);
        acc.fsiu.minor += cost;
        acc.fsiu.printEq = acc.fsiu.printEq.plus(
          new D(qty.toString()).dividedBy(1000).times(run.printRateUsdPerSiu),
        );
      } else {
        const claim = eventFor(m, "settle_split");
        const leg = m.requestId === undefined ? undefined : settlements.get(m.requestId);
        if (claim?.mintCostMinorUnits === undefined || !leg) {
          acc.unmatched += 1;
          continue;
        }
        acc.split.payments += 1;
        acc.split.siu = acc.split.siu.plus(siu);
        acc.split.minor += BigInt(claim.mintCostMinorUnits) + BigInt(leg.settledMinorUnits);
      }
    }
  }
  const printEqMinor = BigInt(acc.fsiu.printEq.times(1_000_000).toFixed(0));
  return {
    usdc: {
      payments: acc.usdc.payments,
      quotedSiu: acc.usdc.siu.toFixed(),
      usd: usdOf(acc.usdc.minor),
      usdPerSiu: perSiu(acc.usdc.minor, acc.usdc.siu),
      escrowNeverSettled: acc.usdc.never,
      settledBelowQuoted: acc.usdc.below,
    },
    fsiu: {
      payments: acc.fsiu.payments,
      quotedSiu: acc.fsiu.siu.toFixed(),
      usd: usdOf(acc.fsiu.minor),
      usdPerSiu: perSiu(acc.fsiu.minor, acc.fsiu.siu),
      printEquivalentUsd: usdOf(printEqMinor),
      printEquivalentUsdPerSiu: perSiu(printEqMinor, acc.fsiu.siu),
      carriedAtOriginalMintCost: acc.fsiu.carried,
    },
    split: {
      payments: acc.split.payments,
      quotedSiu: acc.split.siu.toFixed(),
      usd: usdOf(acc.split.minor),
      usdPerSiu: perSiu(acc.split.minor, acc.split.siu),
    },
    paymentsInUndeliveredWindows: acc.undelivered,
    paymentsWithoutQuote: acc.noQuote,
    unmatched: acc.unmatched,
  };
}
