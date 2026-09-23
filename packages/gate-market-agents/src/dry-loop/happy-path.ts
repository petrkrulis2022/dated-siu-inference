import { CODE_GATE_3_HARDENED } from "@touchstone/task-pack-gate-hardening";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { runRedeemScenario, type RedeemScenarioResult } from "./redeem-scenario.js";

/**
 * WP-5's first checkpoint: "mint -> transfer -> present_for_redemption -> harness executes ->
 * gate passes -> claim retired, headroom restored, receipt emitted." `CODE_GATE_3_HARDENED` is
 * the real, proven-passing hardened gate `code.test.ts`'s own "full G1-G5 pipeline" test already
 * establishes — genuine sandboxed grading, not a stub result.
 */
export async function runHappyPath(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "happy-path",
): Promise<RedeemScenarioResult> {
  return runRedeemScenario({
    devnet,
    runners,
    buyerAgentId: "ORCHESTRATOR",
    holderAgentId: "WORKER-CODE",
    candidateHardenedGate: CODE_GATE_3_HARDENED,
    jobId,
    parentPaymentId: null,
  });
}
