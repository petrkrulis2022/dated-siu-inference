import { describe, expect, it } from "vitest";
import {
  MIN_ELIGIBLE_RUNS,
  decisionRuleVerdict,
  opportunityOf,
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


describe("opportunityOf — did the agent hold what it could have spent, and did it spend it?", () => {
  const m = (agentId: string, tool: string, held: string, asset = tool === "pay" ? "usdc" : "fsiu") => ({
    agentId,
    tool,
    asset,
    heldReceivedMilliSiu: held,
  });
  /** An agent's cumulative flows over the window, in mSIU. */
  const flows = (over: Partial<{ received: string; redeemed: string; out: string }> = {}) => ({
    receivedMilliSiu: over.received ?? "10000",
    redeemedMilliSiu: over.redeemed ?? "0",
    transferredOutKeyedMilliSiu: over.out ?? "0",
  });

  it("is not an opportunity when the agent held nothing it had been given", () => {
    // ORCHESTRATOR paid in dollars, so WORKER-CODE was never handed any fSIU. Counting that run
    // as a "no" is the error the conditioning exists to prevent.
    const r = opportunityOf([m("WORKER-CODE", "pay", "0")], "WORKER-CODE", flows({ received: "0" }));
    expect(r.eligible).toBe(false);
    expect(r.spentOnward).toBe(false);
  });

  it("IS an opportunity declined when it paid in dollars while holding a received claim", () => {
    const r = opportunityOf([m("WORKER-CODE", "pay", "10000")], "WORKER-CODE", flows());
    expect(r).toMatchObject({ eligible: true, spentOnward: false });
  });

  it("counts a claim leaving the balance in a payment, while received fSIU is not all redeemed, as onward spending", () => {
    const r = opportunityOf(
      [m("WORKER-CODE", "transfer_claim", "10000")],
      "WORKER-CODE",
      flows({ out: "4000" }),
    );
    expect(r).toMatchObject({ eligible: true, spentOnward: true, basis: "held_claim_left_the_balance" });
  });

  it("does NOT count it once the agent redeemed everything it had received — the units that left may be its own", () => {
    // Received 10,000, redeemed all 10,000, and paid 4,000 out of what it minted for itself. Units
    // are fungible, so nothing says a received unit went onward; "did not redeem all of what it
    // received" is the condition that separates this from spending.
    const r = opportunityOf(
      [m("WORKER-CODE", "transfer_claim", "10000")],
      "WORKER-CODE",
      flows({ out: "4000", redeemed: "10000" }),
    );
    expect(r.spentOnward).toBe(false);
  });

  it("is balance-level: minting a new claim and forwarding it does not reduce the balance, so it is not onward spending", () => {
    // pay_with_claim and settle_split mint to the seller; the payer's stock of received claims is
    // untouched. An agent that pays this way while holding received fSIU declined to spend it,
    // which is exactly the observation the rule exists to make — counting it as spending would
    // let the rule pass because agents take the shortest fSIU route, not because fSIU circulates.
    for (const tool of ["pay_with_claim", "settle_split"]) {
      const r = opportunityOf([m("WORKER-CODE", tool, "10000", "fsiu")], "WORKER-CODE", flows());
      expect(r, tool).toMatchObject({ eligible: true, spentOnward: false });
      // …but the looser, asset-level reading is reported beside it, so a reader can see it.
      expect(r.paidInFsiuWhileHoldingReceived, tool).toBe(true);
    }
  });

  it("looks only at the named agent", () => {
    const r = opportunityOf(
      [m("ORCHESTRATOR", "transfer_claim", "10000"), m("WORKER-CODE", "pay", "0")],
      "WORKER-CODE",
      flows({ received: "0" }),
    );
    expect(r.eligible).toBe(false);
  });

  it("is eligible if ANY payment found it holding something", () => {
    const r = opportunityOf(
      [m("WORKER-CODE", "pay", "0"), m("WORKER-CODE", "pay", "4000")],
      "WORKER-CODE",
      flows(),
    );
    expect(r.eligible).toBe(true);
  });

  it("never marks an agent that was never paid in fSIU as eligible — the ORCHESTRATOR property", () => {
    // Nothing in this roster pays ORCHESTRATOR in fSIU, so every payment it makes finds it holding
    // no received claim. Whatever it pays with, it can only ever be a "not an opportunity".
    for (const tool of ["pay", "pay_with_claim", "settle_split", "transfer_claim"]) {
      const r = opportunityOf([m("ORCHESTRATOR", tool, "0")], "ORCHESTRATOR", flows({ received: "0", out: "1000" }));
      expect(r.eligible, tool).toBe(false);
      expect(r.spentOnward, tool).toBe(false);
    }
  });

  it("feeds the rule without ever producing the impossible combination it refuses", () => {
    // spentOnward implies eligible by construction, so a run built from real moments can never
    // trip the rule's measurement-error guard.
    for (const held of ["0", "1", "10000"]) {
      const r = opportunityOf(
        [m("WORKER-CODE", "transfer_claim", held)],
        "WORKER-CODE",
        flows({ out: "4000" }),
      );
      expect(r.spentOnward && !r.eligible).toBe(false);
    }
  });
});
