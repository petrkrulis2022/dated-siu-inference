import { describe, expect, it } from "vitest";
import { BudgetCeiling, CeilingExceededError } from "./ceiling.js";

function limits(
  overrides: Partial<{
    maxUsdcSpend: string;
    maxInferenceTurns: number;
    maxInferenceUsd: string;
  }> = {},
) {
  const base = { maxUsdcSpend: "10", maxInferenceTurns: 5, maxInferenceUsd: "10", ...overrides };
  return {
    "ISSUER-A": base,
    "ISSUER-B": base,
    ORCHESTRATOR: base,
    "WORKER-CODE": base,
    "WORKER-EXTRACT": base,
    HEDGER: base,
  };
}

describe("BudgetCeiling", () => {
  it("hard-refuses (never soft-warns) once the USDC spend cap is hit", () => {
    const ceiling = new BudgetCeiling(limits({ maxUsdcSpend: "1.00" }));
    ceiling.recordSpend("ORCHESTRATOR", "W1", "0.60");
    ceiling.recordSpend("ORCHESTRATOR", "W1", "0.30");
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W1", "0.20")).toThrow(CeilingExceededError);
  });

  it("halts the agent permanently for that window after a spend-ceiling hit", () => {
    const ceiling = new BudgetCeiling(limits({ maxUsdcSpend: "1.00" }));
    ceiling.recordSpend("ORCHESTRATOR", "W1", "1.00");
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W1", "0.01")).toThrow(CeilingExceededError);
    expect(ceiling.isHalted("ORCHESTRATOR", "W1")).toBe(true);
    // A second call after halting still throws, even for a trivially small amount — no re-check
    // of "would this specific amount fit," once halted it's halted.
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W1", "0.0001")).toThrow(CeilingExceededError);
  });

  it("keeps each (agent, window) pair independent — halting one never halts another", () => {
    const ceiling = new BudgetCeiling(limits({ maxUsdcSpend: "1.00" }));
    ceiling.recordSpend("ORCHESTRATOR", "W1", "1.00");
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W1", "0.01")).toThrow(CeilingExceededError);

    // Different agent, same window — unaffected.
    expect(() => ceiling.recordSpend("HEDGER", "W1", "0.50")).not.toThrow();
    // Same agent, different window — unaffected (a fresh window resets the cap).
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W2", "0.50")).not.toThrow();
  });

  it("hard-refuses once the inference-turn cap is hit", () => {
    const ceiling = new BudgetCeiling(limits({ maxInferenceTurns: 2 }));
    ceiling.recordTurn("ORCHESTRATOR", "W1");
    ceiling.recordTurn("ORCHESTRATOR", "W1");
    expect(() => ceiling.recordTurn("ORCHESTRATOR", "W1")).toThrow(CeilingExceededError);
  });

  it("reports accurate remaining budget before any ceiling is hit", () => {
    const ceiling = new BudgetCeiling(
      limits({ maxUsdcSpend: "10.00", maxInferenceTurns: 5, maxInferenceUsd: "2.00" }),
    );
    ceiling.recordSpend("ORCHESTRATOR", "W1", "3.50");
    ceiling.recordTurn("ORCHESTRATOR", "W1");
    ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "0.75");
    const remaining = ceiling.remaining("ORCHESTRATOR", "W1");
    expect(remaining.spendUsdc).toBe("6.500000");
    expect(remaining.turns).toBe(4);
    expect(remaining.inferenceUsd).toBe("1.250000");
  });
});

describe("BudgetCeiling — real dollar-based inference ceiling (pre-WP-7 fix, spec §12.2a)", () => {
  it("hard-refuses once projected inference spend would exceed the dollar cap", () => {
    const ceiling = new BudgetCeiling(limits({ maxInferenceUsd: "1.00" }));
    ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "0.60");
    ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "0.30");
    expect(() => ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "0.20")).toThrow(
      CeilingExceededError,
    );
  });

  it("fires on the PROJECTED cost before any real spend is recorded — the property that matters", () => {
    const ceiling = new BudgetCeiling(limits({ maxInferenceUsd: "1.00" }));
    // A single turn projected to cost more than the entire remaining budget must be refused
    // outright, not allowed through and only caught afterward — this is the whole point of
    // checking the *projected* worst case rather than a running realized total.
    expect(() => ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "1.50")).toThrow(
      CeilingExceededError,
    );
    // Nothing was actually spent — the projection alone was enough to refuse.
    expect(ceiling.remaining("ORCHESTRATOR", "W1").inferenceUsd).toBe("1.000000");
  });

  it("can be the ceiling that halts an agent even with USDC/turn budget untouched", () => {
    const ceiling = new BudgetCeiling(
      limits({ maxUsdcSpend: "1000", maxInferenceTurns: 1000, maxInferenceUsd: "0.01" }),
    );
    // Plenty of USDC and turn budget left, but the inference-dollar ceiling is what actually
    // fires — each ceiling is its own real, independently-triggerable property.
    expect(() => ceiling.recordInferenceSpend("ORCHESTRATOR", "W1", "0.02")).toThrow(
      CeilingExceededError,
    );
    // Halting is per-AGENT (spec §9.3: "halt that agent"), not per-ceiling-type — once any
    // ceiling fires, every further action for this agent+window refuses too, matching
    // `Runner.callTool`'s own `isHalted()` gate on the whole tool call, not just one action type.
    expect(() => ceiling.recordSpend("ORCHESTRATOR", "W1", "5")).toThrow(CeilingExceededError);
  });
});
