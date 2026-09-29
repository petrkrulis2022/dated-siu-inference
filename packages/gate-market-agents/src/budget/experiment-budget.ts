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

/**
 * Two totals, deliberately, because they answer different questions and were conflated until
 * 2026-09-29. `totalProjectedInferenceUsd` is the sum of the pre-call worst-case estimates the
 * caps are enforced against — it has to be an over-estimate, since it is computed before the
 * provider has said what the call cost. `totalRealizedInferenceUsd` is what was actually spent,
 * and is the only figure that should ever be reported. In P5 run 3 these were $2.777609 and
 * $1.132689 for the same run: the ledger was overstating real spend by ~2.45x, because the one
 * field it kept was the projection.
 */
interface ExperimentLedger {
  /** Projected (pre-call, worst-case). Cap enforcement only — never report this as spend. */
  totalProjectedInferenceUsd: string;
  /** Real, provider-reported spend. This is the reporting figure. */
  totalRealizedInferenceUsd: string;
  /** Free-text provenance for a correction applied to this file, when one has been. */
  note?: string;
  /** The pre-2026-09-29 field name, which held the PROJECTED total while being read as though it
   * were spend. Retained on read for backward compatibility with a ledger written before the
   * split, and never written again. */
  totalInferenceUsd?: string;
}

function readLedger(ledgerPath: string): ExperimentLedger {
  if (!existsSync(ledgerPath)) {
    return { totalProjectedInferenceUsd: "0", totalRealizedInferenceUsd: "0" };
  }
  const raw = JSON.parse(readFileSync(ledgerPath, "utf-8")) as Partial<ExperimentLedger>;
  // A legacy ledger's single figure was the projected total. It is carried into the projected
  // field, never into the realized one — inventing a realized history from a projection is
  // exactly the overstatement this split exists to end.
  const projected = raw.totalProjectedInferenceUsd ?? raw.totalInferenceUsd ?? "0";
  return {
    totalProjectedInferenceUsd: projected,
    totalRealizedInferenceUsd: raw.totalRealizedInferenceUsd ?? "0",
    ...(raw.note !== undefined ? { note: raw.note } : {}),
  };
}

function writeLedger(ledgerPath: string, ledger: ExperimentLedger): void {
  writeFileSync(
    ledgerPath,
    JSON.stringify(
      {
        totalProjectedInferenceUsd: ledger.totalProjectedInferenceUsd,
        totalRealizedInferenceUsd: ledger.totalRealizedInferenceUsd,
        ...(ledger.note !== undefined ? { note: ledger.note } : {}),
      },
      null,
      2,
    ),
    "utf-8",
  );
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
  private runRealizedUsd = new D(0);

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
    const projectedExperimentTotal = new D(ledger.totalProjectedInferenceUsd).plus(projectedAmount);
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
    writeLedger(this.ledgerPath, {
      ...ledger,
      totalProjectedInferenceUsd: projectedExperimentTotal.toFixed(6),
    });
  }

  /**
   * The provider's own reported cost for a call that has already happened. Never gates anything —
   * by the time it is known the money is spent, and halting on it would only ever halt after the
   * fact. It exists so that the ledger and every report state what was actually spent rather than
   * what was budgeted for. Call it once per completed model call.
   */
  recordRealizedInferenceSpend(realizedUsd: string): void {
    const amount = new D(realizedUsd);
    this.runRealizedUsd = this.runRealizedUsd.plus(amount);
    const ledger = readLedger(this.ledgerPath);
    writeLedger(this.ledgerPath, {
      ...ledger,
      totalRealizedInferenceUsd: new D(ledger.totalRealizedInferenceUsd).plus(amount).toFixed(6),
    });
  }

  /** Real spend this run — the figure to report. */
  runTotalUsd(): string {
    return this.runRealizedUsd.toFixed(6);
  }

  /** Worst-case projection this run, as enforced against `runCapUsd`. Reported alongside real
   * spend when the distance between them is itself worth seeing, never instead of it. */
  runProjectedUsd(): string {
    return this.runSpentUsd.toFixed(6);
  }

  /** Real spend across every recorded run — the figure to report. */
  experimentTotalUsd(): string {
    return readLedger(this.ledgerPath).totalRealizedInferenceUsd;
  }

  /** Projected total across every recorded run, as the experiment cap is enforced against. */
  experimentProjectedUsd(): string {
    return readLedger(this.ledgerPath).totalProjectedInferenceUsd;
  }
}
