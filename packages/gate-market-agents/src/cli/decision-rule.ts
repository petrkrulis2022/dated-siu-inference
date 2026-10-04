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
