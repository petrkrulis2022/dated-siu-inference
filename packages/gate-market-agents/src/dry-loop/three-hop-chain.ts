import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { buildReceiptGraph, assertChildPaymentsWithinParent } from "../receipt/graph.js";
import type { GateMarketReceipt } from "../receipt/types.js";
import { runRedeemScenario } from "./redeem-scenario.js";
import { CODE_GATE_3_HARDENED } from "@touchstone/gate-market";

export const ROOT_JOB_ID = "three-hop-root";
/** The operator's stated job budget — an illustrative devnet fixture, not derived from a real
 * print (same convention as `DRY_LOOP_MICRO_USD_PER_SIU`). */
export const ROOT_JOB_BUDGET_USD = "0.50";

export interface ThreeHopChainResult {
  receipts: GateMarketReceipt[];
  graph: Map<string, GateMarketReceipt[]>;
}

/**
 * Spec §6.3's multi-hop chain, depth 3, scripted (each hop's asset choice is fixed here rather
 * than an agent's own decision — that's WP-7's finding, not this package's): OPERATOR funds
 * ORCHESTRATOR's job (a plain USDC payment, not itself graded work — no `GateMarketReceipt` of
 * its own, just the budget `assertChildPaymentsWithinParent` checks against); ORCHESTRATOR
 * subcontracts WORKER-EXTRACT (hop 1, `parent_payment_id: ROOT_JOB_ID`); WORKER-EXTRACT
 * sub-subcontracts WORKER-CODE (hop 2, `parent_payment_id` = hop 1's own receipt id) — the real
 * depth-3 chain spec §6.3 calls the target, "the point at which unwrapping at every hop would
 * actually cost something." Both hops reuse `runRedeemScenario`'s real `code`-class mint ->
 * transfer -> present -> grade -> serve loop rather than spec's own `extract` illustration — the
 * receipt-graph mechanism this scenario actually tests doesn't depend on which class, and reusing
 * the already-proven `code` fixtures keeps this honest rather than adding new extract-domain
 * plumbing just to match the diagram literally.
 */
export async function runThreeHopChain(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
): Promise<ThreeHopChainResult> {
  const hop1 = await runRedeemScenario({
    devnet,
    runners,
    buyerAgentId: "ORCHESTRATOR",
    holderAgentId: "WORKER-EXTRACT",
    candidateHardenedGate: CODE_GATE_3_HARDENED,
    jobId: "three-hop-hop1",
    parentPaymentId: ROOT_JOB_ID,
  });

  const hop2 = await runRedeemScenario({
    devnet,
    runners,
    buyerAgentId: "WORKER-EXTRACT",
    holderAgentId: "WORKER-CODE",
    candidateHardenedGate: CODE_GATE_3_HARDENED,
    jobId: "three-hop-hop2",
    parentPaymentId: hop1.receipt.receipt_id,
  });

  const receipts = [hop1.receipt, hop2.receipt];
  const graph = buildReceiptGraph(receipts);

  // The property WP-5's own prompt asks to assert: sum of child payments <= parent payment, at
  // every level of the chain.
  assertChildPaymentsWithinParent(graph, ROOT_JOB_ID, ROOT_JOB_BUDGET_USD);
  assertChildPaymentsWithinParent(
    graph,
    hop1.receipt.receipt_id,
    hop1.receipt.usdc_equivalent_at_print,
  );

  return { receipts, graph };
}
