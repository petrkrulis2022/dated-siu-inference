import { CODE_GATE_2_SINGLE_CASE } from "@touchstone/gate-market";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { runRedeemScenario, type RedeemScenarioResult } from "./redeem-scenario.js";

/**
 * WP-5's second checkpoint: the same shape as the happy path, but with a genuinely failing
 * candidate — `CODE_GATE_2_SINGLE_CASE`, confirmed empirically (not assumed) to fail G2 when run
 * through the real pipeline: it incorrectly accepts one of the four adversarial cases. Asserts
 * `claim_retired == false` and headroom unchanged — spec §6.2's own words, "the record that
 * proves failed work counts zero."
 */
export async function runFailingSubmission(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "failing-submission",
): Promise<RedeemScenarioResult> {
  return runRedeemScenario({
    devnet,
    runners,
    buyerAgentId: "ORCHESTRATOR",
    holderAgentId: "WORKER-CODE",
    candidateHardenedGate: CODE_GATE_2_SINGLE_CASE,
    jobId,
    parentPaymentId: null,
  });
}
