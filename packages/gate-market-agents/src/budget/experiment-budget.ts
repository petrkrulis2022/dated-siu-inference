import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { D } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";
import type { BudgetCeiling, SpendCeiling } from "./ceiling.js";

/**
 * The budget hierarchy settled for this run, top-down: experiment cap (all six agents, all
 * windows, all five eventual runs) -> per-run cap -> the existing per-agent-per-window
 * `BudgetCeiling`. This wraps `BudgetCeiling` rather than replacing it — the per-agent-per-window
 * layer stays exactly as built and tested; this only adds the two coarser layers above it.
 *
 * Scoped to *inference* dollar spend specifically, not on-chain USDC — spec §9.4's own cost
 * discussion ("the inference cost here is dominated by agent turns... set the hard ceiling
 * anyway") is about real, external, unrecoverable dollars; USDC exchanged between agents mostly
 * circulates inside the same funded pool rather than leaving it. `BudgetCeiling`'s own
 * `maxUsdcSpend`/`maxInferenceTurns` per-agent-per-window caps are unaffected and still apply
 * independently.
 */
export class ExperimentCapExceededError extends Error {
  constructor(
    public readonly kind: "run" | "experiment",
    public readonly capUsd: string,
  ) {
    super(
      `Projected inference spend would exceed the ${kind === "run" ? "per-run" : "experiment-wide"} ` +
        `cap of $${capUsd} — halting the run rather than exceeding a budget decided in advance.`,
    );
    this.name = "ExperimentCapExceededError";
  }
}

interface ExperimentLedger {
  totalInferenceUsd: string;
}

function readLedger(ledgerPath: string): ExperimentLedger {
  if (!existsSync(ledgerPath)) return { totalInferenceUsd: "0" };
  return JSON.parse(readFileSync(ledgerPath, "utf-8")) as ExperimentLedger;
}

export interface ExperimentBudgetOptions {
  ceiling: BudgetCeiling;
  /** Decimal USD string — this run's own cap (e.g. "30"). */
  runCapUsd: string;
  /** Decimal USD string — the whole-experiment cap across every run (e.g. "150"). Persisted to
   * `ledgerPath` so a later, separate run (a new process) sees the real running total — this
   * ledger starts empty and is never seeded from the precursor passes' own already-spent, already-
   * recorded costs, per the run's own settled "$150, excluding precursor passes" decision. */
  experimentCapUsd: string;
  ledgerPath: string;
}

export class ExperimentBudget implements SpendCeiling {
  private readonly ceiling: BudgetCeiling;
  private readonly runCapUsd: string;
  private readonly experimentCapUsd: string;
  private readonly ledgerPath: string;
  private runSpentUsd = new D(0);

  constructor(options: ExperimentBudgetOptions) {
    this.ceiling = options.ceiling;
    this.runCapUsd = options.runCapUsd;
    this.experimentCapUsd = options.experimentCapUsd;
    this.ledgerPath = options.ledgerPath;
  }

  isHalted(agentId: AgentId, windowId: string): boolean {
    return this.ceiling.isHalted(agentId, windowId);
  }

  recordTurn(agentId: AgentId, windowId: string): void {
    this.ceiling.recordTurn(agentId, windowId);
  }

  recordSpend(agentId: AgentId, windowId: string, usdcAmount: string): void {
    this.ceiling.recordSpend(agentId, windowId, usdcAmount);
  }

  /** Checked top-down against **projected**, not realised, spend — experiment cap first (the
   * coarsest, least likely to be hit but the most consequential to breach), then the run cap,
   * then the existing per-agent-per-window ceiling. Recording only happens once every level has
   * already agreed the projected amount fits. */
  recordInferenceSpend(agentId: AgentId, windowId: string, projectedUsd: string): void {
    const projectedAmount = new D(projectedUsd);
    const ledger = readLedger(this.ledgerPath);
    const projectedExperimentTotal = new D(ledger.totalInferenceUsd).plus(projectedAmount);
    if (projectedExperimentTotal.greaterThan(new D(this.experimentCapUsd))) {
      throw new ExperimentCapExceededError("experiment", this.experimentCapUsd);
    }

    const projectedRunTotal = this.runSpentUsd.plus(projectedAmount);
    if (projectedRunTotal.greaterThan(new D(this.runCapUsd))) {
      throw new ExperimentCapExceededError("run", this.runCapUsd);
    }

    // Only the per-agent-per-window layer can halt just that agent and let the run continue
    // (spec §9.3) — a run/experiment-cap breach halts the whole run, since it means the run
    // itself was mis-budgeted, not that one agent overspent its own share.
    this.ceiling.recordInferenceSpend(agentId, windowId, projectedUsd);

    this.runSpentUsd = projectedRunTotal;
    writeFileSync(
      this.ledgerPath,
      JSON.stringify({ totalInferenceUsd: projectedExperimentTotal.toFixed(6) }, null, 2),
      "utf-8",
    );
  }

  runTotalUsd(): string {
    return this.runSpentUsd.toFixed(6);
  }

  experimentTotalUsd(): string {
    return readLedger(this.ledgerPath).totalInferenceUsd;
  }
}
