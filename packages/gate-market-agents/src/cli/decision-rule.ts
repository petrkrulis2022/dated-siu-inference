/**
 * The decision rule for the single-issuer pilot block, **fixed on 2026-10-04, before any result
 * exists** (single-issuer plan, D5). It is code rather than prose so that it cannot be quietly
 * reinterpreted once a disappointing number is on the table, and it is tested so that what it says
 * is what it does.
 *
 * ## The question
 *
 * Do agents carry fSIU between hands? If they do, cross-issuer fungibility (the pooled two-layer
 * design) is the next build, because a claim that moves needs to be worth the same whoever holds
 * it. If they do not, even in the best case — one issuer per window, no cross-issuer credit risk,
 * always redeemable from the issuer named on the claim — then the pooled design would be solving a
 * problem nobody has, and it is not built.
 *
 * ## Why it is conditioned on opportunity
 *
 * The first draft counted onward spending in every run. That makes a run in which WORKER-CODE was
 * never given any fSIU — ORCHESTRATOR paid in dollars — a "no", when it had no chance to say yes.
 * A buyer that holds nothing cannot spend it onward, and counting that as a negative would let the
 * rule return "not built" for reasons that have nothing to do with whether agents carry fSIU.
 * So only runs in which the agent **held fSIU it had received at the moment it paid** count at
 * all.
 *
 * ## The rule
 *
 *   - fewer than `MIN_ELIGIBLE_RUNS` eligible runs  -> **inconclusive**, not negative;
 *   - otherwise, onward spending in MORE THAN HALF of the eligible runs -> **build**;
 *   - otherwise -> **do not build**, recorded as agents not carrying fSIU between hands even where
 *     they could.
 *
 * ## Revised 2026-10-05, still before any result exists
 *
 * "Held fSIU it had been given" means fSIU received as PAYMENT FROM ANOTHER AGENT — never an
 * opening balance, never an operator grant, never a claim the agent minted for itself. The ledger
 * credits only agent-to-agent movements (an external buyer or the operator's drain is not an agent
 * and is never tracked), and the rule's own tests pin that ORCHESTRATOR, which nothing in this
 * roster pays in fSIU, can never be eligible. If a report ever marks it so, that is a counting
 * error and the block report refuses to compute a verdict.
 *
 * "Spent onward" is defined at the BALANCE level, because fSIU units are fungible and which unit
 * left is not knowable: the agent paid in fSIU **out of its balance** — a transfer that named a
 * quote — while holding fSIU it had received, and **did not redeem all of what it received**. A
 * payment made by minting a fresh claim and forwarding it (`pay_with_claim`, `settle_split`) never
 * touches the balance, so it is not spending the received stock; an agent paying that way while
 * holding received fSIU has declined to spend it, which is what the rule is trying to observe. The
 * looser asset-level reading — paid in fSIU at all while holding received fSIU — is computed and
 * reported beside it (`paidInFsiuWhileHoldingReceived`), never silently substituted for it.
 *
 * This block is a PILOT. F1 is measured in window 1 only, so five runs give five decisions per
 * buyer, and even a perfect 5 of 5 has a 95% Wilson lower bound of n/(n+z²) = 5/8.84, about 0.57.
 * It tells us whether a larger block is worth running. It is not the answer.
 */

/** Fewer eligible runs than this and the block says nothing either way. */
export const MIN_ELIGIBLE_RUNS = 3;

export interface RunOpportunity {
  runId: string;
  /** The agent held fSIU it had RECEIVED at the moment it made a payment. */
  eligible: boolean;
  /** It spent a claim it held onward — passed it to a counterparty — rather than paying otherwise. */
  spentOnward: boolean;
}

export type RuleVerdict = "inconclusive" | "build_cross_issuer_fungibility" | "do_not_build";

export interface RuleOutcome {
  verdict: RuleVerdict;
  runs: number;
  eligible: number;
  spentOnward: number;
  /** Plain-language reason, written for the report so the verdict never travels without it. */
  reason: string;
}

export function decisionRuleVerdict(runs: readonly RunOpportunity[]): RuleOutcome {
  for (const r of runs) {
    // Spending a claim onward requires having held it. A run that says otherwise is a defect in
    // whatever measured it, and folding it into the count would let bad data decide the build.
    if (r.spentOnward && !r.eligible) {
      throw new Error(
        `${r.runId}: recorded as spending a claim onward without having held one. That is a ` +
          "measurement error and must not be counted toward the decision.",
      );
    }
  }
  const eligibleRuns = runs.filter((r) => r.eligible);
  const spent = eligibleRuns.filter((r) => r.spentOnward).length;
  const base = { runs: runs.length, eligible: eligibleRuns.length, spentOnward: spent };

  if (eligibleRuns.length < MIN_ELIGIBLE_RUNS) {
    return {
      verdict: "inconclusive",
      ...base,
      reason:
        `Only ${eligibleRuns.length} of ${runs.length} runs gave the agent fSIU to spend, and ` +
        `${MIN_ELIGIBLE_RUNS} are needed. The block is INCONCLUSIVE, not negative: a run in which ` +
        "the agent held nothing gave it no opportunity to say yes, and is not counted as a no.",
    };
  }
  if (spent * 2 > eligibleRuns.length) {
    return {
      verdict: "build_cross_issuer_fungibility",
      ...base,
      reason:
        `Onward spending in ${spent} of ${eligibleRuns.length} eligible runs, a majority. Agents ` +
        "carry fSIU between hands, so cross-issuer fungibility is the next build. This is a " +
        "pilot: it says a larger block is worth running, not that the question is settled.",
    };
  }
  return {
    verdict: "do_not_build",
    ...base,
    reason:
      `Onward spending in only ${spent} of ${eligibleRuns.length} eligible runs. Agents did not ` +
      "carry fSIU between hands even where they could, in fSIU's best case. Cross-issuer " +
      "fungibility is not built, and this is recorded as the result.",
  };
}

/** The slice of a recorded payment moment the rule needs; see `PaymentMoment` in the loop. */
export interface MomentLike {
  agentId: string;
  tool: string;
  /** What the payment was settled in. A `split` includes a claim leg. */
  asset: string;
  /** mSIU of claims the agent had been GIVEN by another agent and still held when it paid. */
  heldReceivedMilliSiu: string;
}

/** The agent's cumulative claim flows over the window; see `ClaimFlows` in the ledger. */
export interface FlowsLike {
  receivedMilliSiu: string;
  redeemedMilliSiu: string;
  transferredOutKeyedMilliSiu: string;
}

export type OnwardBasis = "none" | "held_claim_left_the_balance";

export interface Opportunity {
  eligible: boolean;
  spentOnward: boolean;
  basis: OnwardBasis;
  /** The LOOSER reading: paid in fSIU at all, by any route, while holding received fSIU it had not
   *  all redeemed. Reported so a difference from `spentOnward` is visible, never substituted. */
  paidInFsiuWhileHoldingReceived: boolean;
}

/**
 * Whether `agent` had the opportunity to spend fSIU onward in one run, and whether it did.
 *
 * `moments` and `flows` must be the F1 window's own — the caller passes window 1's — because
 * windows 2 and 3 route to the non-serving issuer by design and answer a different question.
 *
 * **Eligible**: at the moment of ANY payment, in any asset, the agent held fSIU it had received
 * from another agent. Paying in dollars while holding a received claim counts — that is an
 * opportunity declined. Paying while holding nothing is not an opportunity at all.
 *
 * **Spent onward**, at the balance level (see the header): a claim LEFT the agent's balance in a
 * payment that named a quote, at a moment it held received fSIU, and it did not redeem all of what
 * it received. Condition on redemption is what separates spending from the fungible units that
 * left being the agent's own.
 */
export function opportunityOf(
  moments: readonly MomentLike[],
  agent: string,
  flows: FlowsLike,
): Opportunity {
  const mine = moments.filter((m) => m.agentId === agent);
  const held = (m: MomentLike): boolean => BigInt(m.heldReceivedMilliSiu) > 0n;
  const notAllRedeemed = BigInt(flows.receivedMilliSiu) > BigInt(flows.redeemedMilliSiu);
  const leftTheBalance =
    BigInt(flows.transferredOutKeyedMilliSiu) > 0n &&
    mine.some((m) => m.tool === "transfer_claim" && held(m));
  const spentOnward = leftTheBalance && notAllRedeemed;
  return {
    eligible: mine.some(held),
    spentOnward,
    basis: spentOnward ? "held_claim_left_the_balance" : "none",
    paidInFsiuWhileHoldingReceived:
      notAllRedeemed && mine.some((m) => (m.asset === "fsiu" || m.asset === "split") && held(m)),
  };
}
