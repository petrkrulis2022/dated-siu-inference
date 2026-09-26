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

  /**
   * Found live, 2026-09-26 (P5 window 1, real Base Sepolia run — see
   * data/gate-market/first-real-default-2026-09-26.json): redemption in this system grades the
   * ROUTED ISSUER's own delivery (its capacity_model actually attempting the work), never the
   * holder's — the contract's own invariants (WorkClaim.sol's top doc comment: "redemption
   * failure in this system is always issuer-attributable, since the holder supplies only a task
   * spec and the gate grades the issuer's own served output") assume this. A failing attempt is
   * real and worth logging (the caller's own friction log already does), but is never terminal —
   * only a genuine pass ever makes this tracker "ready to serve"; the issuer keeps trying within
   * its own turns otherwise, and an attempt that never passes is settled once, at window close,
   * by settleWindowClose's own real default path (WorkClaim.sol) — never by a false report here.
   * The caller (loop/full-run.ts) is responsible for calling this ONLY when the grading attempt
   * was genuinely the routed issuer's own — see this class's own issuerAgentId, set at mint.
   */
  recordGraded(passed: boolean, receiptRef: string): void {
    if (!passed) return;
    this.#state.passed = true;
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

  /** Small, structured text telling the routed issuer a claim has genuinely been presented
   * against it and it now owes real work — the corrected economic model's own missing piece:
   * without this, the issuer would have no way to know it must start delivering at all, since
   * `renderFor` below only ever shows once a genuine pass already exists. Empty once a pass is
   * in (deliver is done, `renderFor` takes over) or once served. */
  renderForIssuerAwaitingDelivery(agentId: AgentId): string {
    const s = this.#state;
    if (s.issuerAgentId !== agentId || s.holder === undefined || s.passed !== undefined || s.served) {
      return "";
    }
    return [
      "A CLAIM WAS PRESENTED AGAINST YOU",
      `  tokenId ${s.tokenId}, holder ${s.holder}, quantity ${s.quantity}.`,
      "  You owe this work. Call submit_job with a real deliverable until it genuinely passes,",
      "  then call serve_redemption to report the pass. A failed attempt is not final — keep",
      "  trying within the window. Never report a fail; an undelivered claim defaults against",
      "  your bond automatically when the window closes, you do not report that yourself.",
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
