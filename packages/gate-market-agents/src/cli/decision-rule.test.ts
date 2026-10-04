import { describe, expect, it } from "vitest";
import { MIN_ELIGIBLE_RUNS, decisionRuleVerdict, type RunOpportunity } from "./decision-rule.js";

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
