import type { Print, QuoteAmountPrecision } from "@touchstone/sdk";
import type { ChainClients } from "@touchstone/agents";
import type { GateHardeningJobInputs, GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { ChainReader } from "./chain/reader.js";
import type { GateMarketDeployment } from "./chain/deployment.js";
import type { DualRenderer } from "./context/dual-render.js";
import type { AgentId } from "./identity/resolve.js";

/**
 * Everything a tool handler needs beyond its own arguments and this agent's signing account —
 * injected so every tool is testable with no live chain, no live model, and no filesystem,
 * mirroring `packages/agents/src/seller.ts`'s `SellerDeps` pattern.
 */
/**
 * The currency lab's own service, for the one tool that cannot be a pure function of its arguments:
 * `deliver_job` runs a model on a job and grades it, and must not put the job's expected answer in
 * anything an agent can read — so the job lives here, behind this interface, and the tool passes only
 * the request id.
 */
export interface LabService {
  deliverJob(caller: AgentId, requestId: string): Promise<unknown>;
}

export interface RunnerDeps {
  chainReader: ChainReader;
  deployment: GateMarketDeployment;
  escrowAddress: string;
  runGateHardeningChecks: (inputs: GateHardeningJobInputs) => Promise<GateHardeningResult>;
  loadPrint: (printId: string) => Promise<Print>;
  isReconciled: (printId: string) => Promise<boolean>;
  /** Currency lab runs only. */
  lab?: LabService;
  /**
   * Settle a paid quote by a plain transfer to its seller instead of opening an escrow (`tools/direct-settlement.ts`).
   * Set by the currency lab from instrument v4 (D30); absent everywhere else, so the gate configuration is unchanged.
   */
  directSettlement?: boolean;
  /**
   * How `request_quote` rounds a quote's dollar amount. Absent, the SDK's default: four decimals, half-up (build 1's rule). The
   * currency lab names USDC's own six decimals, rounded up (D50), so a quote priced in SIU is owed in the dollars that price
   * comes to. The gate configuration never sets it.
   */
  quoteAmount?: QuoteAmountPrecision;
}

/** Bundled with `RunnerDeps` for every tool call — this agent's own viem account/clients, held
 * only inside `Runner`, never part of a `ToolCallRecord` and therefore never part of an
 * `AgentContext` — see `runner.ts`'s and `context/assemble.ts`'s doc comments. */
export interface ToolContext {
  /** Who is calling. Present so a tool whose behaviour depends on the caller (`deliver_job`) does not
   *  have to infer it from a key. */
  agentId: AgentId;
  deps: RunnerDeps;
  clients: ChainClients;
  /** This agent's own F3 dual-rendering hook (§7.3) — one instance per agent, alternating which
   * arm is live across calls, shared across every tool call so the alternation is a real
   * sequence rather than reset per call. */
  dualRenderer: DualRenderer;
}
