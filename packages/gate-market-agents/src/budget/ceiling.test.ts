import { describe, expect, it } from "vitest";
import { BudgetCeiling, CeilingExceededError } from "./ceiling.js";

function limits(overrides: Partial<{ maxUsdcSpend: string; maxInferenceTurns: number }> = {}) {
  return {
    "ISSUER-A": { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
    "ISSUER-B": { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
    ORCHESTRATOR: { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
    "WORKER-CODE": { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
    "WORKER-EXTRACT": { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
    HEDGER: { maxUsdcSpend: "10", maxInferenceTurns: 5, ...overrides },
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
    const ceiling = new BudgetCeiling(limits({ maxUsdcSpend: "10.00", maxInferenceTurns: 5 }));
    ceiling.recordSpend("ORCHESTRATOR", "W1", "3.50");
    ceiling.recordTurn("ORCHESTRATOR", "W1");
    const remaining = ceiling.remaining("ORCHESTRATOR", "W1");
    expect(remaining.spendUsdc).toBe("6.500000");
    expect(remaining.turns).toBe(4);
  });
});
