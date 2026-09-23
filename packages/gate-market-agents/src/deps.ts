import type { Print } from "@touchstone/sdk";
import type { ChainClients } from "@touchstone/agents";
import type { GateHardeningJobInputs, GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { ChainReader } from "./chain/reader.js";
import type { GateMarketDeployment } from "./chain/deployment.js";
import type { DualRenderer } from "./context/dual-render.js";

/**
 * Everything a tool handler needs beyond its own arguments and this agent's signing account —
 * injected so every tool is testable with no live chain, no live model, and no filesystem,
 * mirroring `packages/agents/src/seller.ts`'s `SellerDeps` pattern.
 */
export interface RunnerDeps {
  chainReader: ChainReader;
  deployment: GateMarketDeployment;
  escrowAddress: string;
  runGateHardeningChecks: (inputs: GateHardeningJobInputs) => Promise<GateHardeningResult>;
  loadPrint: (printId: string) => Promise<Print>;
  isReconciled: (printId: string) => Promise<boolean>;
}

/** Bundled with `RunnerDeps` for every tool call — this agent's own viem account/clients, held
 * only inside `Runner`, never part of a `ToolCallRecord` and therefore never part of an
 * `AgentContext` — see `runner.ts`'s and `context/assemble.ts`'s doc comments. */
export interface ToolContext {
  deps: RunnerDeps;
  clients: ChainClients;
  /** This agent's own F3 dual-rendering hook (§7.3) — one instance per agent, alternating which
   * arm is live across calls, shared across every tool call so the alternation is a real
   * sequence rather than reset per call. */
  dualRenderer: DualRenderer;
}
