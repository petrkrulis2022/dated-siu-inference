import type { AgentId } from "../identity/resolve.js";

/**
 * Found live, 2026-09-26 (WP-7 P5 window 1 planning): the same class of gap the quote board
 * closes, on the redemption side. `serve_redemption(tokenId, holder, quantity, passed, receiptRef)`
 * needs a real, off-chain grading verdict (`submit_job`'s own result) that nothing on-chain
 * records — `redeem-scenario.ts`'s own scripted version only works because one script calls both
 * `submit_job` and `serve_redemption` itself and threads the result through by hand; two separate
 * live agents (the worker who graded, the issuer who must pay) have no way to see the same fact.
 *
 * Real, structured fields only, populated by the loop from real tool results, never invented.
 *
 * **Claims, and the holders of a claim (rewritten 2026-10-05).** This began as a single slot — one
 * claim, one holder, the quantity minted — which matched the one real job each window carried. It
 * stopped being true the moment fSIU circulated, which is the very thing the testbed measures: the
 * first scripted walk on a fork of the real chain showed a claim passed on in part leaving its first
 * holder with a remainder nobody told it about (so it was never presented, never served), the second
 * holder's share invisible to everything downstream, and — in any window where two buyers paid in
 * fSIU — one claim overwriting the other outright.
 *
 * It is now claims keyed by token, each with a POSITION per holder: what that holder holds, whether
 * it has presented it, what it was served. A token is keyed on issuer, class, series and window — not
 * on the mint call — so two mints against one issuer in one window are one token and their quantities
 * add; and a claim passed on in part is two positions, each its own holder's. Every notice an agent
 * reads is built from that agent's own positions. **With one claim and one holder the text is
 * byte-identical to the single slot's**, which the original tests still hold it to.
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

/** One holder's position in one claim. */
interface Position {
  /** An agent id, or the lower-cased address of a holder that is not an agent. */
  holder: string;
  /** What the holder holds of this token, as the loop's own recorded events say. */
  quantity: bigint;
  /** Given by someone else, as against minted by the holder for itself — only a claim that arrived
   *  is announced to its holder. */
  received: boolean;
  presented: boolean;
  /** What the holder held when it presented — what an issuer is then to serve. */
  presentedQuantity: bigint;
  taskSpecText?: string;
  presentedAtChainSeconds?: number;
  expiresAtChainSeconds?: number;
  served: boolean;
  servedPassed?: boolean;
  unservedWarningShown: boolean;
  lapsingWarningShown: boolean;
  arrivedAtChainSeconds?: number;
  memo?: string;
  settledRequestId?: string;
}

interface Claim {
  tokenId: string;
  /** Absent when the loop saw a transfer of a token whose mint it could not attribute to a roster
   *  agent — a claim somebody was just paid with is still announced to them. */
  issuer?: AgentId;
  /** Everything minted into this token, in every call. */
  mintedQuantity: bigint;
  expiresAtChainSeconds?: number;
  positions: Map<string, Position>;
  /** The last recipient a transfer without a stated source named — the legacy single slot's view. */
  lastRecipient?: string;
  /** Legacy: a claim with no position at all was served by an unqualified `recordServed`. */
  servedWithoutPositions: boolean;
}

/** What an issuer is told it owes, and what it has been told it may serve. */
export interface PresentedPosition {
  tokenId: string;
  holder: string;
  quantity: string;
  graded: boolean;
}

export interface DeliveryRow {
  tokenId: string;
  state: "not_presented" | "presented_awaiting_issuer" | "served_passed" | "served_failed";
  issuer?: AgentId;
  quantityMilliSiu?: string;
}

/** One position still owed to somebody, for settlement once its window has closed. */
export interface OpenPosition {
  tokenId: string;
  holder: string;
  issuer: AgentId | undefined;
  quantity: string;
  presented: boolean;
}

export interface TransferDetail {
  /** Which token moved. Defaults to the most recent claim, which is right whenever there is one. */
  tokenId?: string;
  /** How much moved, as a decimal string. Defaults to the whole of what was minted. */
  quantity?: string;
  /** Who it moved FROM. Absent for a mint delivered straight to its recipient, which nobody held. */
  from?: string;
}

export class RedemptionTracker {
  #claims: Claim[] = [];
  /** Issuer-level grading: one passing delivery serves every position presented against that issuer. */
  #graded = new Map<AgentId, { passed: true; receiptRef: string }>();

  // ----- recording -------------------------------------------------------------------------

  /**
   * A claim was minted. Adds to the token if it already exists — two mints against one issuer in
   * one window are one token — and, when `minter` is given, puts the minted quantity in the
   * minter's own hands (a claim minted for oneself is held, not received).
   */
  recordMint(tokenId: string, issuerAgentId: AgentId, quantity: string, minter?: string): void {
    const q = BigInt(quantity);
    let claim = this.#claims.find((c) => c.tokenId === tokenId);
    if (claim === undefined) {
      claim = {
        tokenId,
        issuer: issuerAgentId,
        mintedQuantity: 0n,
        positions: new Map(),
        servedWithoutPositions: false,
      };
      this.#claims.push(claim);
    }
    claim.issuer = issuerAgentId;
    claim.mintedQuantity += q;
    if (minter !== undefined) this.#credit(claim, minter, q, false);
  }

  /**
   * A real, successful transfer — never invented. Lets the real recipient discover the tokenId it
   * now holds via `renderForHolder`, closing the gap `get_balances` alone can't (see
   * `RedemptionState.transferredTo`'s own doc comment).
   *
   * With `detail` it is exact: `quantity` of `tokenId` moves from `from` (or from nobody, for a mint
   * delivered straight to its recipient) to `to`. Without it — the single-slot form every caller
   * used before — the whole of the most recent claim moves to `to`.
   */
  recordTransfer(to: string, memo?: string, requestId?: string, detail?: TransferDetail): void {
    let claim =
      detail?.tokenId !== undefined
        ? this.#claims.find((c) => c.tokenId === detail.tokenId)
        : this.#claims.at(-1);
    if (claim === undefined && detail?.tokenId !== undefined) {
      // The first the tracker hears of this token is its transfer — the mint's issuer was not a
      // roster agent. What the transfer itself carries is enough to tell its recipient.
      claim = {
        tokenId: detail.tokenId,
        mintedQuantity: BigInt(detail.quantity ?? 0),
        positions: new Map(),
        servedWithoutPositions: false,
      };
      this.#claims.push(claim);
    }
    if (claim === undefined) return;
    if (detail === undefined) {
      // The single-slot form: the claim, whole, is now the recipient's and nobody else's unpresented.
      for (const [holder, p] of claim.positions) if (!p.presented) claim.positions.delete(holder);
    } else if (detail.from !== undefined) {
      this.#debit(claim, detail.from, BigInt(detail.quantity ?? claim.mintedQuantity));
    }
    const quantity = BigInt(detail?.quantity ?? claim.mintedQuantity);
    const position = this.#credit(claim, to, quantity, true);
    claim.lastRecipient = to;
    if (typeof memo === "string" && memo.trim() !== "") position.memo = memo.trim();
    if (typeof requestId === "string" && requestId !== "") position.settledRequestId = requestId;
  }

  /**
   * The claim's real expiry, from the chain read the capacity recorder already makes.
   *
   * Ignores a tokenId it does not know, so another claim's event cannot overwrite this one's
   * deadline. A position's `arrivedAtChainSeconds` latches the first time the claim's expiry is
   * seen after the position exists: it is when that holder first held it, which is the anchor the
   * lapsing warning measures against.
   */
  recordExpiry(tokenId: string, expiresAtChainSeconds: number, nowChainSeconds: number): void {
    const claim = this.#claims.find((c) => c.tokenId === tokenId);
    if (claim === undefined) return;
    claim.expiresAtChainSeconds = expiresAtChainSeconds;
    for (const p of claim.positions.values()) p.arrivedAtChainSeconds ??= nowChainSeconds;
  }

  /**
   * A holder presented its claim. What the issuer is then to serve is what the holder holds NOW —
   * a claim passed on in part presents only the remainder, and an issuer told to serve the minted
   * quantity would be told to serve more than exists.
   */
  recordPresented(
    holder: string,
    taskSpecText?: string,
    /** Real figures from the `redeem_claim` result, never wall-clock guesses. Omitted when the
     *  tool did not return an expiry, in which case the holder simply gets no timed warning. */
    timing?: { atChainSeconds: number; secondsToExpiry: number },
    tokenId?: string,
  ): void {
    const claim =
      tokenId !== undefined
        ? this.#claims.find((c) => c.tokenId === tokenId)
        : (this.#claims.find((c) => c.positions.get(holder)?.received && !c.positions.get(holder)?.presented) ??
          this.#claims.at(-1));
    if (claim === undefined) return;
    // Presenting without having been recorded as holding (the single-slot form) presents the whole.
    const position =
      claim.positions.get(holder) ?? this.#credit(claim, holder, claim.mintedQuantity, true);
    position.presented = true;
    position.presentedQuantity = position.quantity;
    if (taskSpecText !== undefined) position.taskSpecText = taskSpecText;
    if (timing !== undefined) {
      position.presentedAtChainSeconds = timing.atChainSeconds;
      position.expiresAtChainSeconds = timing.atChainSeconds + timing.secondsToExpiry;
      claim.expiresAtChainSeconds = position.expiresAtChainSeconds;
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
   * was genuinely the routed issuer's own.
   *
   * A pass grades the issuer, not one position: the job is the same job whoever presented, so one
   * delivered gate that passes serves every position presented against that issuer, before or after.
   * `issuer` defaults to the issuer of the most recent claim, which is the single-slot form.
   */
  recordGraded(passed: boolean, receiptRef: string, issuer?: AgentId): void {
    if (!passed) return;
    const who = issuer ?? this.#claims.at(-1)?.issuer;
    if (who === undefined) return;
    this.#graded.set(who, { passed: true, receiptRef });
  }

  /**
   * What the issuer reported for one holder's position. `passed` is what the ISSUER reported on
   * chain, which is not necessarily the grading verdict the loop observed — see
   * `RedemptionState.servedPassed`. A serve of less than the position leaves the rest owed.
   */
  recordServed(passed: boolean, detail?: { tokenId?: string; holder?: string; quantity?: string }): void {
    const claim =
      detail?.tokenId !== undefined
        ? this.#claims.find((c) => c.tokenId === detail.tokenId)
        : this.#claims.at(-1);
    if (claim === undefined) return;
    const position =
      detail?.holder !== undefined
        ? claim.positions.get(detail.holder)
        : [...claim.positions.values()].find((p) => p.presented && !p.served);
    if (position === undefined) {
      claim.servedWithoutPositions = true;
      return;
    }
    const served = detail?.quantity !== undefined ? BigInt(detail.quantity) : position.presentedQuantity;
    position.servedPassed = passed;
    // A pass burns what it served; a fail retires nothing (WorkClaim.serveRedemption), so the holder
    // still holds it and the position is closed only in the sense that the issuer has reported.
    if (passed) position.quantity -= served < position.quantity ? served : position.quantity;
    position.served = !passed || position.quantity === 0n;
    if (passed && position.quantity > 0n) position.presentedQuantity = position.quantity;
  }

  markUnservedWarningShown(agentId?: string): void {
    for (const p of this.#positionsOf(agentId)) p.unservedWarningShown = true;
  }

  markLapsingWarningShown(agentId?: string): void {
    for (const p of this.#positionsOf(agentId)) p.lapsingWarningShown = true;
  }

  // ----- queries the loop makes -------------------------------------------------------------

  /**
   * The single-slot view of the claim most recently in play. Kept for callers that want one claim's
   * facts and for the tests that pin them; the loop's decisions use the per-agent queries below.
   */
  state(): Readonly<RedemptionState> {
    const claim = this.#claims.at(-1);
    if (claim === undefined) return { served: false };
    const presenter = [...claim.positions.values()].filter((p) => p.presented).at(-1);
    const recipient = claim.lastRecipient !== undefined ? claim.positions.get(claim.lastRecipient) : undefined;
    const graded = claim.issuer !== undefined ? this.#graded.get(claim.issuer) : undefined;
    const shown = presenter ?? recipient;
    return {
      tokenId: claim.tokenId,
      issuerAgentId: claim.issuer,
      ...(claim.lastRecipient !== undefined ? { transferredTo: claim.lastRecipient as AgentId } : {}),
      ...(presenter !== undefined ? { holder: presenter.holder as AgentId } : {}),
      quantity: (presenter?.presentedQuantity ?? claim.mintedQuantity).toString(),
      ...(presenter?.taskSpecText !== undefined ? { taskSpecText: presenter.taskSpecText } : {}),
      ...(graded !== undefined ? { passed: true, receiptRef: graded.receiptRef } : {}),
      served: presenter?.served ?? claim.servedWithoutPositions,
      ...(presenter?.servedPassed !== undefined ? { servedPassed: presenter.servedPassed } : {}),
      ...(presenter?.presentedAtChainSeconds !== undefined
        ? { presentedAtChainSeconds: presenter.presentedAtChainSeconds }
        : {}),
      ...((presenter?.expiresAtChainSeconds ?? claim.expiresAtChainSeconds) !== undefined
        ? { expiresAtChainSeconds: presenter?.expiresAtChainSeconds ?? claim.expiresAtChainSeconds }
        : {}),
      ...(presenter?.unservedWarningShown ? { unservedWarningShown: true } : {}),
      ...(shown?.arrivedAtChainSeconds !== undefined ? { arrivedAtChainSeconds: shown.arrivedAtChainSeconds } : {}),
      ...(recipient?.lapsingWarningShown ? { lapsingWarningShown: true } : {}),
      ...(recipient?.memo !== undefined ? { memo: recipient.memo } : {}),
      ...(recipient?.settledRequestId !== undefined ? { settledRequestId: recipient.settledRequestId } : {}),
    };
  }

  /**
   * What `agentId` stands on, in the single-slot shape `submitJobRefusalFor` reads: a live claim it
   * holds or has presented, else a claim it is the routed issuer of, else nothing. A holder that has
   * passed all of a claim on no longer stands on it.
   */
  viewFor(agentId: string): Readonly<RedemptionState> {
    for (const claim of this.#claims) {
      const p = claim.positions.get(agentId);
      if (p === undefined || p.quantity === 0n || p.served) continue;
      return {
        tokenId: claim.tokenId,
        issuerAgentId: claim.issuer,
        quantity: p.quantity.toString(),
        ...(p.presented ? { holder: agentId as AgentId } : { transferredTo: agentId as AgentId }),
        served: false,
      };
    }
    const issued = this.#claims.filter((c) => c.issuer === agentId).at(-1);
    if (issued !== undefined) return { tokenId: issued.tokenId, issuerAgentId: agentId as AgentId, served: false };
    return { served: false };
  }

  isIssuerOfAny(agentId: string): boolean {
    return this.#claims.some((c) => c.issuer === agentId);
  }

  /** Is anything minted still awaiting service? A claim nobody has presented counts, as it always has. */
  anyUnserved(): boolean {
    return this.#claims.some((c) =>
      c.positions.size === 0
        ? !c.servedWithoutPositions
        : [...c.positions.values()].some((p) => !p.served && p.quantity > 0n),
    );
  }

  /** Everything presented against `issuer` and not yet served, graded or not. */
  presentedAgainst(issuer: string): PresentedPosition[] {
    return this.#presentedAgainst(issuer).map(({ claim, position }) => ({
      tokenId: claim.tokenId,
      holder: position.holder,
      quantity: position.presentedQuantity.toString(),
      graded: this.#isGraded(claim),
    }));
  }

  /** For `check_delivery`: each position this agent holds or has presented, and where it stands. */
  deliveryFor(agentId: string): DeliveryRow[] {
    const rows: DeliveryRow[] = [];
    for (const claim of this.#claims) {
      const p = claim.positions.get(agentId);
      if (p === undefined || (p.quantity === 0n && !p.presented)) continue;
      const state: DeliveryRow["state"] = p.served
        ? this.#isGraded(claim)
          ? "served_passed"
          : "served_failed"
        : p.presented
          ? "presented_awaiting_issuer"
          : "not_presented";
      rows.push({
        tokenId: claim.tokenId,
        state,
        issuer: claim.issuer,
        quantityMilliSiu: (p.presented ? p.presentedQuantity : p.quantity).toString(),
      });
    }
    return rows;
  }

  /** Did the issuer serve a FAIL to this holder? The one served outcome that is actionable. */
  servedFailureFor(agentId: string): boolean {
    return this.#claims.some((c) => {
      const p = c.positions.get(agentId);
      return p !== undefined && p.served && p.servedPassed === false;
    });
  }

  /**
   * Every position still held by anyone, with whether it was presented — what settlement needs.
   * Anything with a balance, served or not: a serve that FAILED retires nothing, so the holder still
   * holds the claim and it still settles at close (a presented claim defaults against the bond).
   */
  positions(): OpenPosition[] {
    return this.#claims.flatMap((claim) =>
      [...claim.positions.values()]
        .filter((p) => p.quantity > 0n)
        .map((p) => ({
          tokenId: claim.tokenId,
          holder: p.holder,
          issuer: claim.issuer,
          quantity: (p.presented ? p.presentedQuantity : p.quantity).toString(),
          presented: p.presented,
        })),
    );
  }

  // ----- rendering --------------------------------------------------------------------------

  /** Small, structured text for the routed issuer's own turn — empty for every other agent, and
   * empty for the routed issuer too until every real fact is actually in. */
  renderFor(agentId: AgentId): string {
    const ready = this.#presentedAgainst(agentId).filter(({ claim }) => this.#isGraded(claim));
    if (ready.length === 0) return "";
    return [
      "PENDING REDEMPTION ROUTED TO YOU",
      ...ready.map(({ claim, position }) => {
        const graded = this.#graded.get(claim.issuer!)!;
        return (
          `  tokenId ${claim.tokenId}, holder ${position.holder}, quantity ${position.presentedQuantity}, ` +
          `real graded result: passed=${graded.passed}, receiptRef ${graded.receiptRef}`
        );
      }),
      "  Call serve_redemption with exactly these values once you've confirmed them.",
    ].join("\n");
  }

  /** Small, structured text for the real recipient of a transferred claim — empty once it has
   * actually been presented (recordPresented), so a holder isn't told to redeem something it
   * already redeemed. Empty for every agent that holds nothing it was given. */
  renderForHolder(agentId: AgentId, nowChainSeconds?: number): string {
    return this.#arrivals(agentId)
      .map(({ claim, position }) => {
        // The deadline, added 2026-10-03 (`fsiu-design.md` §4.3a). Without it this notice gave a
        // tokenId and a quantity and left the one number that decides what the claim is worth — how
        // long it has — unobtainable from any surface, while the loop held it all along.
        const remaining =
          nowChainSeconds !== undefined && claim.expiresAtChainSeconds !== undefined
            ? claim.expiresAtChainSeconds - nowChainSeconds
            : undefined;
        return [
          "A WORK CLAIM WAS TRANSFERRED TO YOU",
          `  tokenId ${claim.tokenId}, quantity ${position.quantity}.` +
            (remaining !== undefined ? ` Its delivery window closes in ${remaining}s.` : ""),
          // What it settled, from the loop's own record rather than anyone's say-so.
          ...(position.settledRequestId !== undefined
            ? [`  It settles your quote ${position.settledRequestId}.`]
            : []),
          // The payer's own words, quoted and attributed, never paraphrased — and absent entirely
          // when nothing was said, so silence stays legible as silence.
          ...(position.memo !== undefined ? [`  The sender said what it is for: "${position.memo}"`] : []),
          "  Confirm with get_balances (pass this tokenId), then call redeem_claim once ready.",
        ].join("\n");
      })
      .join("\n\n");
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
    return this.#arrivals(agentId)
      .filter(({ position }) => !position.lapsingWarningShown)
      .filter(({ claim, position }) => {
        if (position.arrivedAtChainSeconds === undefined || claim.expiresAtChainSeconds === undefined) return false;
        const held = nowChainSeconds - position.arrivedAtChainSeconds;
        const remaining = claim.expiresAtChainSeconds - nowChainSeconds;
        return remaining > 0 && held > remaining;
      })
      .map(({ claim, position }) => {
        const held = nowChainSeconds - position.arrivedAtChainSeconds!;
        const remaining = claim.expiresAtChainSeconds! - nowChainSeconds;
        return [
          "A CLAIM YOU HOLD HAS NOT BEEN PRESENTED, AND ITS WINDOW IS CLOSING",
          `  tokenId ${claim.tokenId}, quantity ${position.quantity}. You have held it ${held}s and it closes ` +
            `in ${remaining}s.`,
          "  Presenting it is what makes the work owed: a claim presented and then not served is",
          "  claimable against the issuer's bond, and one that was never presented simply expires",
          "  and pays nothing. After this window the claim cannot be presented, redeemed or passed",
          "  on, whatever its balance says.",
          "  You are told this once. What to do about it, including nothing, is yours to decide.",
        ].join("\n");
      })
      .join("\n\n");
  }

  /**
   * The holder's side of a served claim — the hole run 16 fell into (spec §4.6ae).
   *
   * `renderForHolder` above goes empty the instant a claim is PRESENTED, by design: its job is
   * "you were transferred this, go present it". From that moment until the end of the window no
   * renderer in the system addresses the holder at all. It is not told when the work passes,
   * when a serve is refused, or when its window closes unserved. A holder that had declared
   * `{"wait": true}` after presenting therefore waited forever, and the run that existed to
   * measure whether a holder notices non-delivery could not have measured it.
   *
   * Informational on a PASS and actionable on a FAIL — see `wakeKey` in `loop/full-run.ts`. The
   * distinction matters: a holder that got what it paid for has nothing new to do, and waking it
   * would be §4.6ac returning. A holder whose work failed has the rest of the window to buy
   * replacement work, which is a real and newly-available action.
   */
  renderServedForHolder(agentId: AgentId): string {
    return this.#claims
      .flatMap((claim) => {
        const p = claim.positions.get(agentId);
        return p !== undefined && p.presented && p.served ? [{ claim, position: p }] : [];
      })
      .map(({ claim, position }) => {
        const quantity = position.presentedQuantity;
        return position.servedPassed === false
          ? [
              "YOUR CLAIM WAS SERVED, AND THE WORK DID NOT PASS",
              `  tokenId ${claim.tokenId}, quantity ${quantity}, issuer ${claim.issuer ?? "(unknown)"}.`,
              "  The issuer has reported. This claim is spent and the work it bought did not pass.",
              "  Whatever you still need from this window, you would have to buy again.",
            ].join("\n")
          : [
              "YOUR CLAIM WAS SERVED",
              `  tokenId ${claim.tokenId}, quantity ${quantity}, issuer ${claim.issuer ?? "(unknown)"}. The work passed.`,
              "  Nothing is outstanding to you on this claim.",
            ].join("\n");
      })
      .join("\n\n");
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
   * Shown once per position (`markUnservedWarningShown`), never once per round.
   */
  renderUnservedForHolder(agentId: AgentId, nowChainSeconds: number): string {
    return this.#claims
      .flatMap((claim) => {
        const p = claim.positions.get(agentId);
        return p !== undefined && p.presented && !p.served && !p.unservedWarningShown ? [{ claim, position: p }] : [];
      })
      .filter(({ position }) => {
        if (position.presentedAtChainSeconds === undefined || position.expiresAtChainSeconds === undefined) return false;
        const waited = nowChainSeconds - position.presentedAtChainSeconds;
        const remaining = position.expiresAtChainSeconds - nowChainSeconds;
        return remaining > 0 && waited > remaining;
      })
      .map(({ claim, position }) => {
        const waited = nowChainSeconds - position.presentedAtChainSeconds!;
        const remaining = position.expiresAtChainSeconds! - nowChainSeconds;
        return [
          "A CLAIM YOU PRESENTED IS STILL UNSERVED",
          `  tokenId ${claim.tokenId}, quantity ${position.presentedQuantity}. You presented it ${waited}s ago and it ` +
            `expires in ${remaining}s.`,
          "  Nothing is owed to you until it is served. If its window closes unserved it defaults",
          "  against the issuer's bond, and the bond pays you — that is what the bond is for.",
          "  You are told this once. What to do about it, including nothing, is yours to decide.",
        ].join("\n");
      })
      .join("\n\n");
  }

  /** Small, structured text telling the routed issuer a claim has genuinely been presented
   * against it and it now owes real work — the corrected economic model's own missing piece:
   * without this, the issuer would have no way to know it must start delivering at all, since
   * `renderFor` above only ever shows once a genuine pass already exists. Empty once a pass is
   * in (deliver is done, `renderFor` takes over) or once served. */
  renderForIssuerAwaitingDelivery(agentId: AgentId): string {
    const owed = this.#presentedAgainst(agentId).filter(({ claim }) => !this.#isGraded(claim));
    if (owed.length === 0) return "";
    const spec = owed.map(({ position }) => position.taskSpecText).find((t) => t !== undefined);
    return [
      "A CLAIM WAS PRESENTED AGAINST YOU",
      ...owed.map(
        ({ claim, position }) =>
          `  tokenId ${claim.tokenId}, holder ${position.holder}, quantity ${position.presentedQuantity}.`,
      ),
      "  You owe this work. Call submit_job with a real deliverable until it genuinely passes,",
      "  then call serve_redemption to report the pass. A failed attempt is not final — keep",
      "  trying within the window. Never report a fail; an undelivered claim defaults against",
      "  your bond automatically when the window closes, you do not report that yourself.",
      // The spec the holder presented, in full. Without it the instruction above is unactionable:
      // an issuer told to author a gate for a job it has never seen can only guess, which is
      // exactly what both issuers did on 2026-09-29.
      ...(spec !== undefined
        ? ["", "  THE TASK THIS CLAIM WAS PRESENTED AGAINST — everything you need to author it:", spec]
        : []),
    ].join("\n");
  }

  // ----- internals --------------------------------------------------------------------------

  #isGraded(claim: Claim): boolean {
    return claim.issuer !== undefined && this.#graded.has(claim.issuer);
  }

  #credit(claim: Claim, holder: string, quantity: bigint, received: boolean): Position {
    let p = claim.positions.get(holder);
    if (p === undefined) {
      p = {
        holder,
        quantity: 0n,
        received,
        presented: false,
        presentedQuantity: 0n,
        served: false,
        unservedWarningShown: false,
        lapsingWarningShown: false,
      };
      claim.positions.set(holder, p);
    }
    p.quantity += quantity;
    // Anything given to the holder makes the position one that was received.
    if (received) p.received = true;
    // More arriving in a position that has already been presented is not what was presented.
    if (p.presented) p.served = false;
    return p;
  }

  /** Never goes negative: a transfer larger than the record knows of is a gap in the record, and the
   *  chain, which would have reverted, is the authority. */
  #debit(claim: Claim, holder: string, quantity: bigint): void {
    const p = claim.positions.get(holder);
    if (p === undefined) return;
    p.quantity -= quantity < p.quantity ? quantity : p.quantity;
    if (p.quantity === 0n && !p.presented) claim.positions.delete(holder);
  }

  /** Positions announced to their holder: received, not yet presented, still held. */
  #arrivals(agentId: string): { claim: Claim; position: Position }[] {
    return this.#claims.flatMap((claim) => {
      const p = claim.positions.get(agentId);
      return p !== undefined && p.received && !p.presented && p.quantity > 0n && !p.served ? [{ claim, position: p }] : [];
    });
  }

  #presentedAgainst(issuer: string): { claim: Claim; position: Position }[] {
    return this.#claims
      .filter((c) => c.issuer === issuer)
      .flatMap((claim) =>
        [...claim.positions.values()]
          .filter((p) => p.presented && !p.served && p.presentedQuantity > 0n)
          .map((position) => ({ claim, position })),
      );
  }

  #positionsOf(agentId?: string): Position[] {
    return this.#claims.flatMap((c) =>
      agentId === undefined ? [...c.positions.values()] : c.positions.has(agentId) ? [c.positions.get(agentId)!] : [],
    );
  }
}
