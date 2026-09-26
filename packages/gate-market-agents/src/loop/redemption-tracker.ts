import type { AgentId } from "../identity/resolve.js";

/**
 * Found live, 2026-09-26 (WP-7 P5 window 1 planning): the same class of gap the quote board
 * closes, on the redemption side. `serve_redemption(tokenId, holder, quantity, passed, receiptRef)`
 * needs a real, off-chain grading verdict (`submit_job`'s own result) that nothing on-chain
 * records — `redeem-scenario.ts`'s own scripted version only works because one script calls both
 * `submit_job` and `serve_redemption` itself and threads the result through by hand; two separate
 * live agents (the worker who graded, the issuer who must pay) have no way to see the same fact.
 *
 * Scoped to this window's one real job (this package's own `loop/full-run.ts` doc comment already
 * discloses "one job at a time for now" as a real, separate gap) — a single-slot tracker, not a
 * general multi-job registry. Real, structured fields only, populated by the loop from real tool
 * results, never invented.
 */
export interface RedemptionState {
  tokenId?: string;
  issuerAgentId?: AgentId;
  /** Real, on-chain fact from a successful `transfer_claim` (2026-09-26, P5 window 1 live run —
   * found live: ORCHESTRATOR minted and transferred a real claim, but WORKER-CODE had no way to
   * discover the tokenId it now held — `get_balances(account, tokenIds)` requires already
   * knowing which tokenIds to check, it never enumerates what an account holds). Distinct from
   * `holder`, which means "the agent that actually called redeem_claim" — a claim can be
   * transferred without yet being presented. */
  transferredTo?: AgentId;
  holder?: AgentId;
  quantity?: string;
  passed?: boolean;
  receiptRef?: string;
  served: boolean;
}

export class RedemptionTracker {
  #state: RedemptionState = { served: false };

  recordMint(tokenId: string, issuerAgentId: AgentId, quantity: string): void {
    this.#state.tokenId = tokenId;
    this.#state.issuerAgentId = issuerAgentId;
    this.#state.quantity = quantity;
  }

  /** Called right after a real, successful `transfer_claim` — never invented. Lets the real
   * recipient discover the tokenId it now holds via `renderForHolder`, closing the gap
   * `get_balances` alone can't (see `RedemptionState.transferredTo`'s own doc comment). */
  recordTransfer(to: AgentId): void {
    this.#state.transferredTo = to;
  }

  /** The full minted quantity is assumed presented — this window's one real job never splits a
   * claim across a transfer/presentation, matching the same single-job simplification this
   * tracker's own top comment already discloses. */
  recordPresented(holder: AgentId): void {
    this.#state.holder = holder;
  }

  recordGraded(passed: boolean, receiptRef: string): void {
    this.#state.passed = passed;
    this.#state.receiptRef = receiptRef;
  }

  recordServed(): void {
    this.#state.served = true;
  }

  state(): Readonly<RedemptionState> {
    return this.#state;
  }

  /** Ready the instant every real fact `serve_redemption` needs is known and it hasn't been
   * served yet — never before, so an issuer is never prompted to act on a partial picture. */
  private isReadyToServe(): boolean {
    const s = this.#state;
    return (
      !s.served &&
      s.tokenId !== undefined &&
      s.holder !== undefined &&
      s.quantity !== undefined &&
      s.passed !== undefined &&
      s.receiptRef !== undefined
    );
  }

  /** Small, structured text for the real recipient of a transferred claim — empty once it has
   * actually been presented (recordPresented), so a holder isn't told to redeem something it
   * already redeemed. Empty for every agent that isn't the real transferredTo. */
  renderForHolder(agentId: AgentId): string {
    if (this.#state.transferredTo !== agentId || this.#state.holder !== undefined) return "";
    return [
      "A WORK CLAIM WAS TRANSFERRED TO YOU",
      `  tokenId ${this.#state.tokenId}, quantity ${this.#state.quantity}.`,
      "  Confirm with get_balances (pass this tokenId), then call redeem_claim once ready.",
    ].join("\n");
  }

  /** Small, structured text for the routed issuer's own turn — empty for every other agent, and
   * empty for the routed issuer too until every real fact is actually in. */
  renderFor(agentId: AgentId): string {
    if (this.#state.issuerAgentId !== agentId || !this.isReadyToServe()) return "";
    const s = this.#state;
    return [
      "PENDING REDEMPTION ROUTED TO YOU",
      `  tokenId ${s.tokenId}, holder ${s.holder}, quantity ${s.quantity}, ` +
        `real graded result: passed=${s.passed}, receiptRef ${s.receiptRef}`,
      "  Call serve_redemption with exactly these values once you've confirmed them.",
    ].join("\n");
  }
}
