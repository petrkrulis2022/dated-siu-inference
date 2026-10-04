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
  /**
   * The task specification the holder presented with the claim — the source materials, reference
   * inputs and gate contract the routed issuer needs in order to author anything at all.
   *
   * It travels with the redemption rather than sitting in anyone's static pack, because that is
   * what a claim is: a promise of work, redeemed against a task the holder presents. Before
   * 2026-09-29 it sat only in WORKER-CODE's own pack, so the issuer that actually owed the
   * delivery had never seen the job. Every gate an issuer submitted was empty or malformed, every
   * window that ever passed was passed by WORKER-CODE, and once `toolGuard` correctly stopped the
   * holder authoring, no valid gate was reachable at all. The issuer also sees this only for a
   * claim genuinely presented against it, which keeps its context to work it has actually been
   * asked to do.
   */
  taskSpecText?: string;
  passed?: boolean;
  receiptRef?: string;
  served: boolean;
  /**
   * What the issuer actually reported when it served. Distinct from `passed`, which is the
   * grading verdict the loop observed from `submit_job`: an issuer can serve a FAIL (the
   * contract permits it and emits `Served(…, passed=false, …)`), and the holder's position is
   * entirely different in the two cases. Undefined until a serve happens.
   */
  servedPassed?: boolean;
  /**
   * The chain-clock instant the claim was presented, and the instant it expires — both derived
   * from the `redeem_claim` result's own `timeToExpirySeconds`, measured against the chain clock
   * at the moment of the decision. Present only when that real figure came back.
   *
   * They exist for the holder's unserved warning, whose trigger is "you have waited longer than
   * you have left" — see `renderUnservedForHolder`.
   */
  presentedAtChainSeconds?: number;
  expiresAtChainSeconds?: number;
  /** The unserved warning is shown once per claim, never once per round — see §4.6ac. */
  unservedWarningShown?: boolean;
  /**
   * When this claim first became visible to the loop, and when it expires — both from the real
   * `holdTimeToExpiry` read `recordCapacityEvent` already performs, so neither costs an extra
   * RPC and neither is a wall-clock guess.
   *
   * They exist because the arrival notice used to carry a tokenId and a quantity and nothing
   * else. A holder could know the rule — the shared claim facts state plainly that an
   * unpresented claim "simply expires and pays nothing" — and still have no way to tell how long
   * it had. Run 17's holder planned to spend its claim on adversarial testing "later", which was
   * a real use and a sound plan in every respect except that the claim died forty minutes after
   * it arrived (`fsiu-design.md` §4.3a).
   */
  arrivedAtChainSeconds?: number;
  /** Shown once, like the unserved warning, and for the same §4.6ac reason. */
  lapsingWarningShown?: boolean;
  /**
   * What the payer said this claim was for, in its own words, if it said anything.
   *
   * Never synthesised. An absent memo renders as nothing at all rather than as a guess about
   * the payer's intent: the point is to carry what was actually said, and inventing a purpose
   * would be worse than the silence it replaces.
   */
  memo?: string;
  /**
   * The quote this claim settled, when it settled one — so the recipient is told what it was paid
   * FOR by the loop's own record, not by the payer's goodwill. This is what the optional memo was
   * reaching for: run 17's holder asked, in its friction log, "whether this claim was meant as
   * payment for a gate-authoring job I'm expected to produce, or is simply an independent
   * position". Once every claim payment settles a quote, the answer is structural.
   */
  settledRequestId?: string;
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
  recordTransfer(to: AgentId, memo?: string, requestId?: string): void {
    this.#state.transferredTo = to;
    if (typeof memo === "string" && memo.trim() !== "") this.#state.memo = memo.trim();
    if (typeof requestId === "string" && requestId !== "") this.#state.settledRequestId = requestId;
  }

  /**
   * The claim's real expiry, from the chain read the capacity recorder already makes.
   *
   * Ignores a tokenId that is not the tracked claim's, so a second claim's event cannot
   * overwrite the first's deadline. `arrivedAtChainSeconds` latches on the first call: it is
   * when this claim became visible, which is the anchor the lapsing warning measures against.
   */
  recordExpiry(tokenId: string, expiresAtChainSeconds: number, nowChainSeconds: number): void {
    if (this.#state.tokenId !== undefined && this.#state.tokenId !== tokenId) return;
    this.#state.expiresAtChainSeconds = expiresAtChainSeconds;
    this.#state.arrivedAtChainSeconds ??= nowChainSeconds;
  }

  /** The full minted quantity is assumed presented — this window's one real job never splits a
   * claim across a transfer/presentation, matching the same single-job simplification this
   * tracker's own top comment already discloses. */
  recordPresented(
    holder: AgentId,
    taskSpecText?: string,
    /** Real figures from the `redeem_claim` result, never wall-clock guesses. Omitted when the
     *  tool did not return an expiry, in which case the holder simply gets no timed warning. */
    timing?: { atChainSeconds: number; secondsToExpiry: number },
  ): void {
    this.#state.holder = holder;
    if (taskSpecText !== undefined) this.#state.taskSpecText = taskSpecText;
    if (timing !== undefined) {
      this.#state.presentedAtChainSeconds = timing.atChainSeconds;
      this.#state.expiresAtChainSeconds = timing.atChainSeconds + timing.secondsToExpiry;
    }
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

  /** `passed` is what the ISSUER reported on chain, which is not necessarily the grading verdict
   *  the loop observed — see `RedemptionState.servedPassed`. */
  recordServed(passed: boolean): void {
    this.#state.served = true;
    this.#state.servedPassed = passed;
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
  renderForHolder(agentId: AgentId, nowChainSeconds?: number): string {
    const s = this.#state;
    if (s.transferredTo !== agentId || s.holder !== undefined) return "";
    // The deadline, added 2026-10-03 (`fsiu-design.md` §4.3a). Without it this notice gave a
    // tokenId and a quantity and left the one number that decides what the claim is worth — how
    // long it has — unobtainable from any surface, while the loop held it all along.
    const remaining =
      nowChainSeconds !== undefined && s.expiresAtChainSeconds !== undefined
        ? s.expiresAtChainSeconds - nowChainSeconds
        : undefined;
    return [
      "A WORK CLAIM WAS TRANSFERRED TO YOU",
      `  tokenId ${s.tokenId}, quantity ${s.quantity}.` +
        (remaining !== undefined ? ` Its delivery window closes in ${remaining}s.` : ""),
      // What it settled, from the loop's own record rather than anyone's say-so.
      ...(s.settledRequestId !== undefined
        ? [`  It settles your quote ${s.settledRequestId}.`]
        : []),
      // The payer's own words, quoted and attributed, never paraphrased — and absent entirely
      // when nothing was said, so silence stays legible as silence.
      ...(s.memo !== undefined
        ? [`  The sender said what it is for: "${s.memo}"`]
        : []),
      "  Confirm with get_balances (pass this tokenId), then call redeem_claim once ready.",
    ].join("\n");
  }

  /**
   * Held, never presented, and its window is running out.
   *
   * The counterpart of `renderUnservedForHolder`, for the stage before presentation, and the
   * more consequential of the two: an unpresented claim at window close is `Expired` — the
   * holder receives nothing and the issuer's capacity returns to it — whereas a presented one
   * is `Defaulted` and the bond pays. Run 17 lost a holder 10,000 mSIU this way, silently.
   *
   * Same discipline as every other holder section (§4.6ae): built only from this claim's own
   * arrival and expiry, says nothing about the issuer, names no tool, and leaves doing nothing
   * genuinely open. A holder that lets a claim lapse knowingly is a result worth having; one
   * that lets it lapse because nobody mentioned the deadline is not a result at all.
   */
  renderUnpresentedLapsingForHolder(agentId: AgentId, nowChainSeconds: number): string {
    const s = this.#state;
    if (s.transferredTo !== agentId || s.holder !== undefined || s.served) return "";
    if (s.lapsingWarningShown) return "";
    if (s.arrivedAtChainSeconds === undefined || s.expiresAtChainSeconds === undefined) return "";
    const held = nowChainSeconds - s.arrivedAtChainSeconds;
    const remaining = s.expiresAtChainSeconds - nowChainSeconds;
    if (remaining <= 0 || held <= remaining) return "";
    return [
      "A CLAIM YOU HOLD HAS NOT BEEN PRESENTED, AND ITS WINDOW IS CLOSING",
      `  tokenId ${s.tokenId}, quantity ${s.quantity}. You have held it ${held}s and it closes ` +
        `in ${remaining}s.`,
      "  Presenting it is what makes the work owed: a claim presented and then not served is",
      "  claimable against the issuer's bond, and one that was never presented simply expires",
      "  and pays nothing. After this window the claim cannot be presented, redeemed or passed",
      "  on, whatever its balance says.",
      "  You are told this once. What to do about it, including nothing, is yours to decide.",
    ].join("\n");
  }

  markLapsingWarningShown(): void {
    this.#state.lapsingWarningShown = true;
  }

  /**
   * The holder's side of a served claim — the hole run 16 fell into (spec §4.6ae).
   *
   * `renderForHolder` above goes empty the instant a claim is PRESENTED, by design: its job is
   * "you were transferred this, go present it". From that moment until the end of the window no
   * renderer in the system addresses the holder at all. It is not told when the work passes,
   * when a serve is refused, or when its window closes unserved. A holder that declared
   * `{"wait": true}` after presenting therefore waited forever, and the run that existed to
   * measure whether a holder notices non-delivery could not have measured it.
   *
   * Informational on a PASS and actionable on a FAIL — see `wakeKey` in `loop/full-run.ts`. The
   * distinction matters: a holder that got what it paid for has nothing new to do, and waking it
   * would be §4.6ac returning. A holder whose work failed has the rest of the window to buy
   * replacement work, which is a real and newly-available action.
   */
  renderServedForHolder(agentId: AgentId): string {
    const s = this.#state;
    if (s.holder !== agentId || !s.served) return "";
    return s.servedPassed === false
      ? [
          "YOUR CLAIM WAS SERVED, AND THE WORK DID NOT PASS",
          `  tokenId ${s.tokenId}, quantity ${s.quantity}, issuer ${s.issuerAgentId}.`,
          "  The issuer has reported. This claim is spent and the work it bought did not pass.",
          "  Whatever you still need from this window, you would have to buy again.",
        ].join("\n")
      : [
          "YOUR CLAIM WAS SERVED",
          `  tokenId ${s.tokenId}, quantity ${s.quantity}, issuer ${s.issuerAgentId}. The work passed.`,
          "  Nothing is outstanding to you on this claim.",
        ].join("\n");
  }

  /**
   * Presented, still unserved, and the holder has now waited longer than it has left.
   *
   * **The trigger is deliberately built only from the holder's own facts** — when it presented
   * and when the claim expires, both of which came back in its own `redeem_claim` result.
   * Nothing here is derived from the issuer's state. That is not fastidiousness: this run
   * withholds `serve_redemption` from `NON_SERVING_ISSUER` precisely so that *the holder
   * noticing* is the thing being measured, and a warning triggered by the issuer's refusals
   * would hand over the answer and turn the measurement into a disclosure.
   *
   * "Waited longer than remaining" needs no tuned constant and scales with the window: with a
   * claim presented at `P` expiring at `E`, it fires once `now` passes the midpoint of `P..E`.
   * Shown once per claim (`markUnservedWarningShown`), never once per round.
   */
  renderUnservedForHolder(agentId: AgentId, nowChainSeconds: number): string {
    const s = this.#state;
    if (s.holder !== agentId || s.served || s.unservedWarningShown) return "";
    if (s.presentedAtChainSeconds === undefined || s.expiresAtChainSeconds === undefined) return "";
    const waited = nowChainSeconds - s.presentedAtChainSeconds;
    const remaining = s.expiresAtChainSeconds - nowChainSeconds;
    if (remaining <= 0 || waited <= remaining) return "";
    return [
      "A CLAIM YOU PRESENTED IS STILL UNSERVED",
      `  tokenId ${s.tokenId}, quantity ${s.quantity}. You presented it ${waited}s ago and it ` +
        `expires in ${remaining}s.`,
      "  Nothing is owed to you until it is served. If its window closes unserved it defaults",
      "  against the issuer's bond, and the bond pays you — that is what the bond is for.",
      "  You are told this once. What to do about it, including nothing, is yours to decide.",
    ].join("\n");
  }

  /** Bounded exactly like `shownForwardOffers`: a standing fact that nobody acts on must not
   *  wake its holder on every cursor for the rest of the window. */
  markUnservedWarningShown(): void {
    this.#state.unservedWarningShown = true;
  }

  /** Small, structured text telling the routed issuer a claim has genuinely been presented
   * against it and it now owes real work — the corrected economic model's own missing piece:
   * without this, the issuer would have no way to know it must start delivering at all, since
   * `renderFor` below only ever shows once a genuine pass already exists. Empty once a pass is
   * in (deliver is done, `renderFor` takes over) or once served. */
  renderForIssuerAwaitingDelivery(agentId: AgentId): string {
    const s = this.#state;
    if (
      s.issuerAgentId !== agentId ||
      s.holder === undefined ||
      s.passed !== undefined ||
      s.served
    ) {
      return "";
    }
    return [
      "A CLAIM WAS PRESENTED AGAINST YOU",
      `  tokenId ${s.tokenId}, holder ${s.holder}, quantity ${s.quantity}.`,
      "  You owe this work. Call submit_job with a real deliverable until it genuinely passes,",
      "  then call serve_redemption to report the pass. A failed attempt is not final — keep",
      "  trying within the window. Never report a fail; an undelivered claim defaults against",
      "  your bond automatically when the window closes, you do not report that yourself.",
      // The spec the holder presented, in full. Without it the instruction above is unactionable:
      // an issuer told to author a gate for a job it has never seen can only guess, which is
      // exactly what both issuers did on 2026-09-29.
      ...(s.taskSpecText !== undefined
        ? [
            "",
            "  THE TASK THIS CLAIM WAS PRESENTED AGAINST — everything you need to author it:",
            s.taskSpecText,
          ]
        : []),
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
