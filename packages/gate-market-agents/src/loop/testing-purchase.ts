/**
 * Adversarial testing as something a buyer pays for (single-issuer plan, D4; spec §4.6an).
 *
 * Until this existed `submit_attack` had no payment check — its four `throw`s are argument
 * validation — and WORKER-EXTRACT woke the moment a gate existed. The 4,000 mSIU "attack
 * testing" quote was a tip for a service rendered anyway, which is why WORKER-CODE has never
 * bought in any run. A purchase that changes nothing is not a decision, and F1 needs two buyers
 * deciding.
 *
 * **This is an instrument change, and is recorded as one: `passed` now includes the testing
 * purchase settling.** A window in which nobody pays for testing is recorded as not passed
 * whatever else was delivered, and the reason is recorded with it so that "the buyer declined"
 * is a result rather than a silence. Windows that do not set the option keep the old meaning of
 * `passed` exactly, so the single-agent loops and every existing test are untouched.
 *
 * The choice of asset stays free. Engagement is detected from the board's own record that a quote
 * the attacker issued has been settled — in dollars, in claims, or in both — never from which
 * tool was used.
 */
import type { QuoteBoard } from "./quote-board.js";

export type IncompleteBecause =
  /** No gate passed its checks at all. */
  | "no_gate"
  /** A gate passed, and nobody paid for it to be tested. The buyer's decision, observed. */
  | "testing_never_purchased"
  /** Testing was paid for and the adversary never attacked: the seller's non-delivery. */
  | "never_attacked";

/** Has a quote sold by an attacker been settled? Asset-agnostic by construction. */
export function testingEngaged(board: QuoteBoard, attackerSellerIds: readonly string[]): boolean {
  return attackerSellerIds.some((sellerId) =>
    board.issuedQuotesBySeller(sellerId).some((q) => board.isPaid(q.requestId)),
  );
}

/**
 * Why a `submit_attack` call is refused right now, or null if it may proceed. Written from the
 * SELLER's side — the only agent it is ever shown to — and says nothing about what a buyer
 * should do: the instrument's rule is stated once, as a fact, in the shared run description.
 */
export function submitAttackRefusalFor(
  toolName: string,
  testingPurchaseRequired: boolean,
  engaged: boolean,
): string | null {
  if (toolName !== "submit_attack") return null;
  if (!testingPurchaseRequired || engaged) return null;
  return (
    "testing is a service you sell, and nobody has paid for it in this window yet, so there is " +
    "nothing to test. It begins when a quote you issued has been settled, in either asset. " +
    "Until then the useful thing is to answer any open request addressed to you."
  );
}

export interface WindowCompletionInput {
  required: boolean;
  /** A gate passed G1-G6 — the old meaning of `passed`. */
  gateDelivered: boolean;
  engaged: boolean;
  attacked: boolean;
}

export function windowCompletion(i: WindowCompletionInput): {
  passed: boolean;
  incompleteBecause?: IncompleteBecause;
} {
  if (!i.required) return { passed: i.gateDelivered };
  if (!i.gateDelivered) return { passed: false, incompleteBecause: "no_gate" };
  if (!i.engaged) return { passed: false, incompleteBecause: "testing_never_purchased" };
  if (!i.attacked) return { passed: false, incompleteBecause: "never_attacked" };
  return { passed: true };
}
