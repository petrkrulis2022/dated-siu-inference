import { describe, expect, it } from "vitest";
import {
  MIN_ELIGIBLE_RUNS,
  decisionRuleVerdict,
  opportunityFromMoments,
  type RunOpportunity,
} from "./decision-rule.js";

const run = (id: number, eligible: boolean, spentOnward: boolean): RunOpportunity => ({
  runId: `r${id}`,
  eligible,
  spentOnward,
});

describe("the decision rule, fixed before any result exists", () => {
  it("is INCONCLUSIVE, not negative, when too few runs gave the agent fSIU to spend", () => {
    // The point of conditioning on opportunity. Five runs in which WORKER-CODE never held a claim
    // would have read as five "no"s under the unconditioned rule and produced "do not build" from
    // data that says nothing about whether agents carry fSIU.
    const out = decisionRuleVerdict([1, 2, 3, 4, 5].map((i) => run(i, false, false)));
    expect(out.verdict).toBe("inconclusive");
    expect(out.eligible).toBe(0);
    expect(out.reason).toMatch(/INCONCLUSIVE, not negative/);
  });

  it("needs MIN_ELIGIBLE_RUNS eligible runs before it will say anything", () => {
    expect(MIN_ELIGIBLE_RUNS).toBe(3);
    const two = decisionRuleVerdict([run(1, true, true), run(2, true, true), run(3, false, false)]);
    expect(two.verdict).toBe("inconclusive");
    const three = decisionRuleVerdict([run(1, true, true), run(2, true, true), run(3, true, true)]);
    expect(three.verdict).not.toBe("inconclusive");
  });

  it("builds on a MAJORITY of eligible runs, counting only the eligible ones", () => {
    // Two ineligible runs must not dilute a real majority among the three that could say yes.
    const out = decisionRuleVerdict([
      run(1, true, true),
      run(2, true, true),
      run(3, true, false),
      run(4, false, false),
      run(5, false, false),
    ]);
    expect(out.eligible).toBe(3);
    expect(out.spentOnward).toBe(2);
    expect(out.verdict).toBe("build_cross_issuer_fungibility");
  });

  it("does NOT build on exactly half — a majority means strictly more than half", () => {
    const out = decisionRuleVerdict([
      run(1, true, true),
      run(2, true, true),
      run(3, true, false),
      run(4, true, false),
    ]);
    expect(out.eligible).toBe(4);
    expect(out.spentOnward).toBe(2);
    expect(out.verdict).toBe("do_not_build");
  });

  it("does not build when agents had the chance and did not take it", () => {
    const out = decisionRuleVerdict([1, 2, 3, 4, 5].map((i) => run(i, true, false)));
    expect(out.verdict).toBe("do_not_build");
    expect(out.reason).toMatch(/even where they could/);
  });

  it("builds when every eligible run spent onward", () => {
    const out = decisionRuleVerdict([1, 2, 3, 4, 5].map((i) => run(i, true, true)));
    expect(out.verdict).toBe("build_cross_issuer_fungibility");
  });

  it("refuses data that says a claim was spent onward without having been held", () => {
    // A defect in whatever measured it. Counting it would let bad data decide the build.
    expect(() => decisionRuleVerdict([run(1, false, true)])).toThrow(/measurement error/);
  });

  it("every verdict carries its reason, so the verdict never travels alone", () => {
    for (const runs of [
      [1, 2, 3].map((i) => run(i, true, true)),
      [1, 2, 3].map((i) => run(i, true, false)),
      [1, 2, 3].map((i) => run(i, false, false)),
    ]) {
      expect(decisionRuleVerdict(runs).reason.length).toBeGreaterThan(40);
    }
  });

  it("states the pilot caveat on a build verdict", () => {
    const out = decisionRuleVerdict([1, 2, 3].map((i) => run(i, true, true)));
    expect(out.reason).toMatch(/pilot/);
  });
});


describe("opportunityFromMoments — did the agent hold what it could have spent?", () => {
  const m = (agentId: string, tool: string, held: string) => ({
    agentId,
    tool,
    heldReceivedMilliSiu: held,
  });

  it("is not an opportunity when the agent held nothing it had been given", () => {
    // ORCHESTRATOR paid in dollars, so WORKER-CODE was never handed any fSIU. Counting that run
    // as a "no" is the error the conditioning exists to prevent.
    const r = opportunityFromMoments([m("WORKER-CODE", "pay", "0")], "WORKER-CODE");
    expect(r).toEqual({ eligible: false, spentOnward: false });
  });

  it("IS an opportunity declined when it paid in dollars while holding a received claim", () => {
    const r = opportunityFromMoments([m("WORKER-CODE", "pay", "10000")], "WORKER-CODE");
    expect(r).toEqual({ eligible: true, spentOnward: false });
  });

  it("counts passing a held claim on with transfer_claim as onward spending", () => {
    const r = opportunityFromMoments([m("WORKER-CODE", "transfer_claim", "10000")], "WORKER-CODE");
    expect(r).toEqual({ eligible: true, spentOnward: true });
  });

  it("does NOT count minting a new claim as onward spending, even while holding one", () => {
    // pay_with_claim and settle_split create a claim that did not exist. A claim that did not
    // already exist cannot have moved.
    for (const tool of ["pay_with_claim", "settle_split"]) {
      const r = opportunityFromMoments([m("WORKER-CODE", tool, "10000")], "WORKER-CODE");
      expect(r, tool).toEqual({ eligible: true, spentOnward: false });
    }
  });

  it("looks only at the named agent", () => {
    const r = opportunityFromMoments(
      [m("ORCHESTRATOR", "transfer_claim", "10000"), m("WORKER-CODE", "pay", "0")],
      "WORKER-CODE",
    );
    expect(r).toEqual({ eligible: false, spentOnward: false });
  });

  it("is eligible if ANY payment found it holding something", () => {
    const r = opportunityFromMoments(
      [m("WORKER-CODE", "pay", "0"), m("WORKER-CODE", "pay", "4000")],
      "WORKER-CODE",
    );
    expect(r.eligible).toBe(true);
  });

  it("feeds the rule without ever producing the impossible combination it refuses", () => {
    // spentOnward implies eligible by construction, so a run built from real moments can never
    // trip the rule's measurement-error guard.
    for (const held of ["0", "1", "10000"]) {
      const r = opportunityFromMoments([m("WORKER-CODE", "transfer_claim", held)], "WORKER-CODE");
      expect(r.spentOnward && !r.eligible).toBe(false);
    }
  });
});
