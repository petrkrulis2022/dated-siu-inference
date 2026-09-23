import { D, type DecimalValue } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";

/**
 * Spec §9.2's "Agent turn budget capped per agent per window" and "Spend ceiling hard USDC cap
 * per agent; hard inference cap per window" — enforced here, in the substrate, ahead of where
 * the spec's own WP-7 prompt assigns it ("Enforce every abort condition in spec 9.3... on
 * ceiling, halt that agent, continue"). Moved earlier deliberately (see this package's plan /
 * `docs/gate-market-spec.md`): WP-7 should wire real agents onto an already-tested guardrail,
 * not add one under time pressure once real dollars are flowing.
 *
 * Pattern-matched to `packages/print/src/cli/publish-unattended.ts`'s `PUBLISH_SPEND_CEILING_USD`
 * shape: a hard cap that refuses outright, never a soft warning.
 */
export interface BudgetLimits {
  /** Decimal USD string — no floats in money maths, matching every other money value in this
   * repo (CLAUDE.md hard invariant 4). */
  maxUsdcSpend: string;
  maxInferenceTurns: number;
  /** Spec §12.2a's `inference_ceiling_usd` — a real dollar cap on model inference spend,
   * distinct from `maxInferenceTurns` (a turn *count*, which stops meaning anything once one
   * agent's turns cost ten times another's — pre-WP-7 fix, 2026-09-23). Checked against the
   * *projected* worst-case cost of the next turn (`recordInferenceSpend`), before it happens. */
  maxInferenceUsd: string;
}

export class CeilingExceededError extends Error {
  constructor(
    public readonly agentId: AgentId,
    public readonly windowId: string,
    public readonly kind: "spend" | "turns" | "inference",
  ) {
    super(
      `${agentId} hit its ${
        { spend: "USDC spend", turns: "inference-turn", inference: "inference-dollar" }[kind]
      } ceiling for window ${windowId} — halting this agent, the run continues for the others ` +
        "(spec §9.3).",
    );
    this.name = "CeilingExceededError";
  }
}

interface WindowState {
  spentUsdc: DecimalValue;
  spentInferenceUsd: DecimalValue;
  turnsUsed: number;
  halted: boolean;
}

/**
 * One ceiling tracker per run, shared across all six agents. `recordTurn`/`recordSpend` are
 * called from the tool-call dispatch path (`Runner.callTool`) before a turn/spend is allowed to
 * proceed — never after, so a ceiling hit can never be exceeded even by one call.
 */
export class BudgetCeiling {
  private readonly limits: Record<AgentId, BudgetLimits>;
  private readonly windows = new Map<string, WindowState>();

  constructor(limits: Record<AgentId, BudgetLimits>) {
    this.limits = limits;
  }

  private key(agentId: AgentId, windowId: string): string {
    return `${agentId}::${windowId}`;
  }

  private stateFor(agentId: AgentId, windowId: string): WindowState {
    const key = this.key(agentId, windowId);
    let state = this.windows.get(key);
    if (!state) {
      state = {
        spentUsdc: new D(0),
        spentInferenceUsd: new D(0),
        turnsUsed: 0,
        halted: false,
      };
      this.windows.set(key, state);
    }
    return state;
  }

  /** True once this agent has been halted for this window — checked by the Runner before even
   * attempting a tool call, so a halted agent produces no further turns or friction-log noise. */
  isHalted(agentId: AgentId, windowId: string): boolean {
    return this.windows.get(this.key(agentId, windowId))?.halted ?? false;
  }

  /** Throws `CeilingExceededError` and marks the agent halted for this window if the turn count
   * would exceed the limit. Call once per model turn, before the turn's tool calls run. */
  recordTurn(agentId: AgentId, windowId: string): void {
    const state = this.stateFor(agentId, windowId);
    if (state.halted) throw new CeilingExceededError(agentId, windowId, "turns");
    const limit = this.limits[agentId].maxInferenceTurns;
    if (state.turnsUsed + 1 > limit) {
      state.halted = true;
      throw new CeilingExceededError(agentId, windowId, "turns");
    }
    state.turnsUsed += 1;
  }

  /** Throws `CeilingExceededError` and marks the agent halted for this window if `usdcAmount`
   * (decimal USD string) would push cumulative spend past the cap. Call before the USDC transfer
   * that would cause the spend, not after. */
  recordSpend(agentId: AgentId, windowId: string, usdcAmount: string): void {
    const state = this.stateFor(agentId, windowId);
    if (state.halted) throw new CeilingExceededError(agentId, windowId, "spend");
    const limit = new D(this.limits[agentId].maxUsdcSpend);
    const projected = state.spentUsdc.plus(new D(usdcAmount));
    if (projected.greaterThan(limit)) {
      state.halted = true;
      throw new CeilingExceededError(agentId, windowId, "spend");
    }
    state.spentUsdc = projected;
  }

  /** Throws `CeilingExceededError` and marks the agent halted for this window if
   * `projectedUsd` (the *worst-case* dollar cost of the next turn — see
   * `budget/inference-cost.ts`'s `projectedTurnCostUsd`) would push cumulative inference spend
   * past `maxInferenceUsd`. Call before the real model call it's projecting, not after — spec
   * §12.2a: "projected inference cost... against that agent's inference_ceiling_usd." Separate
   * from `recordSpend` (on-chain USDC) and `recordTurn` (a turn count) — a run can legitimately
   * hit any one of the three first, and each is its own real property worth its own halt reason. */
  recordInferenceSpend(agentId: AgentId, windowId: string, projectedUsd: string): void {
    const state = this.stateFor(agentId, windowId);
    if (state.halted) throw new CeilingExceededError(agentId, windowId, "inference");
    const limit = new D(this.limits[agentId].maxInferenceUsd);
    const projected = state.spentInferenceUsd.plus(new D(projectedUsd));
    if (projected.greaterThan(limit)) {
      state.halted = true;
      throw new CeilingExceededError(agentId, windowId, "inference");
    }
    state.spentInferenceUsd = projected;
  }

  remaining(
    agentId: AgentId,
    windowId: string,
  ): { spendUsdc: string; turns: number; inferenceUsd: string } {
    const state = this.stateFor(agentId, windowId);
    const limit = this.limits[agentId];
    return {
      spendUsdc: new D(limit.maxUsdcSpend).minus(state.spentUsdc).toFixed(6),
      turns: limit.maxInferenceTurns - state.turnsUsed,
      inferenceUsd: new D(limit.maxInferenceUsd).minus(state.spentInferenceUsd).toFixed(6),
    };
  }
}
