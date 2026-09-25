import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BudgetCeiling, CeilingExceededError } from "./ceiling.js";
import { ExperimentBudget, ExperimentCapExceededError } from "./experiment-budget.js";

const ZERO = { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" } as const;

function generousCeiling(): BudgetCeiling {
  return new BudgetCeiling({
    "ISSUER-A": ZERO,
    "ISSUER-B": ZERO,
    ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 100, maxInferenceUsd: "1000" },
    "WORKER-CODE": ZERO,
    "WORKER-EXTRACT": ZERO,
    HEDGER: ZERO,
  });
}

describe("ExperimentBudget", () => {
  let scratchDir: string;
  let ledgerPath: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), "experiment-budget-test-"));
    ledgerPath = join(scratchDir, "ledger.json");
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it("delegates to the underlying per-agent-per-window BudgetCeiling and still enforces it", () => {
    const budget = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "1000",
      experimentCapUsd: "1000",
      ledgerPath,
    });
    const tightCeiling = new BudgetCeiling({
      "ISSUER-A": ZERO, "ISSUER-B": ZERO, ORCHESTRATOR: ZERO, "WORKER-CODE": ZERO, "WORKER-EXTRACT": ZERO, HEDGER: ZERO,
    });
    const tightBudget = new ExperimentBudget({
      ceiling: tightCeiling,
      runCapUsd: "1000",
      experimentCapUsd: "1000",
      ledgerPath,
    });
    expect(() => tightBudget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.01")).toThrow(CeilingExceededError);
    expect(() => budget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.01")).not.toThrow();
  });

  it("halts on a projected spend breaching the per-run cap, even with headroom left in the per-agent ceiling", () => {
    const budget = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "0.05",
      experimentCapUsd: "1000",
      ledgerPath,
    });
    budget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.03");
    expect(() => budget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.03")).toThrow(ExperimentCapExceededError);
  });

  it("halts on a projected spend breaching the experiment-wide cap, checked ahead of the run cap", () => {
    const budget = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "1000",
      experimentCapUsd: "0.05",
      ledgerPath,
    });
    budget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.03");
    expect(() => budget.recordInferenceSpend("ORCHESTRATOR", "w1", "0.03")).toThrow(ExperimentCapExceededError);
  });

  it("persists the experiment total across separate ExperimentBudget instances (separate runs)", () => {
    const runOne = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "1000",
      experimentCapUsd: "10",
      ledgerPath,
    });
    runOne.recordInferenceSpend("ORCHESTRATOR", "w1", "7");
    expect(runOne.experimentTotalUsd()).toBe("7.000000");

    // A fresh instance, a fresh BudgetCeiling — simulating a second run's own separate process,
    // sharing only the ledger file on disk.
    const runTwo = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "1000",
      experimentCapUsd: "10",
      ledgerPath,
    });
    expect(runTwo.experimentTotalUsd()).toBe("7.000000");
    // Only 3 left of the real $10 experiment cap — the second run inherits the first run's real spend.
    expect(() => runTwo.recordInferenceSpend("ORCHESTRATOR", "w1", "4")).toThrow(ExperimentCapExceededError);
    expect(() => runTwo.recordInferenceSpend("ORCHESTRATOR", "w1", "3")).not.toThrow();
  });

  it("does not mutate the per-agent ceiling or the persisted ledger when a cap-breaching call is refused", () => {
    const budget = new ExperimentBudget({
      ceiling: generousCeiling(),
      runCapUsd: "0.01",
      experimentCapUsd: "1000",
      ledgerPath,
    });
    expect(() => budget.recordInferenceSpend("ORCHESTRATOR", "w1", "5")).toThrow(ExperimentCapExceededError);
    expect(budget.runTotalUsd()).toBe("0.000000");
    expect(budget.experimentTotalUsd()).toBe("0");
  });
});
