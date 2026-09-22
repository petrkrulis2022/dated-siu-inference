import { D } from "@touchstone/sdk";
import type { GateMarketReceipt } from "./types.js";

/**
 * Spec §6.4: "Where did value leak? Sum of child payments against parent payment, per job."
 * Compares `usdc_equivalent_at_print` — the one field every receipt carries regardless of which
 * `settlement_asset` actually settled that hop (spec §6.3's whole point: each agent chooses
 * USDC or fSIU per hop) — raw `settlement_amount` would sum incomparable units across a chain
 * that mixes assets. Decimal-string arithmetic throughout, no floats (CLAUDE.md hard invariant
 * 4).
 */
export function buildReceiptGraph(
  receipts: readonly GateMarketReceipt[],
): Map<string, GateMarketReceipt[]> {
  const graph = new Map<string, GateMarketReceipt[]>();
  for (const receipt of receipts) {
    if (receipt.parent_payment_id === null) continue;
    const children = graph.get(receipt.parent_payment_id) ?? [];
    children.push(receipt);
    graph.set(receipt.parent_payment_id, children);
  }
  return graph;
}

export class ChildPaymentsExceedParentError extends Error {
  constructor(
    public readonly parentPaymentId: string,
    public readonly childSumUsd: string,
    public readonly parentAmountUsd: string,
  ) {
    super(
      `Receipt graph: child payments for parent ${parentPaymentId} sum to $${childSumUsd}, ` +
        `exceeding the parent payment of $${parentAmountUsd} — value leaked.`,
    );
    this.name = "ChildPaymentsExceedParentError";
  }
}

/** Throws `ChildPaymentsExceedParentError` if the sum of a job's child receipts' USD-equivalent
 * value exceeds `parentAmountUsd` — the property WP-5's own prompt asks to assert for the 3-hop
 * chain. A parent with no children sums to $0, always within any nonnegative parent amount. */
export function assertChildPaymentsWithinParent(
  graph: Map<string, GateMarketReceipt[]>,
  parentPaymentId: string,
  parentAmountUsd: string,
): void {
  const children = graph.get(parentPaymentId) ?? [];
  const childSum = children.reduce(
    (sum, receipt) => sum.plus(new D(receipt.usdc_equivalent_at_print)),
    new D(0),
  );
  if (childSum.greaterThan(new D(parentAmountUsd))) {
    throw new ChildPaymentsExceedParentError(
      parentPaymentId,
      childSum.toFixed(6),
      new D(parentAmountUsd).toFixed(6),
    );
  }
}
