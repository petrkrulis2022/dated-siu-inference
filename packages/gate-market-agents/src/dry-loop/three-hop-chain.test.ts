import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runThreeHopChain, ROOT_JOB_ID } from "./three-hop-chain.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("WP-5 — the 3-hop chain and receipt graph reconstruction (spec §6.3/§6.4)", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("reconstructs a real depth-3 chain with parent_payment_id set at every hop", async () => {
    const { receipts, graph } = await runThreeHopChain(devnet, runners);

    expect(receipts).toHaveLength(2);
    const [hop1, hop2] = receipts;

    expect(hop1.parent_payment_id).toBe(ROOT_JOB_ID);
    expect(hop2.parent_payment_id).toBe(hop1.receipt_id);
    expect(hop1.buyer).toBe("ORCHESTRATOR");
    expect(hop1.executor).toBe("WORKER-EXTRACT");
    expect(hop2.buyer).toBe("WORKER-EXTRACT");
    expect(hop2.executor).toBe("WORKER-CODE");

    // Both hops are real, graded work — genuinely passed G1-G5, genuinely retired.
    expect(hop1.claim_retired).toBe(true);
    expect(hop2.claim_retired).toBe(true);

    // The graph really groups by parent_payment_id (assertChildPaymentsWithinParent inside
    // runThreeHopChain already asserted the sum property without throwing — this re-confirms
    // the graph structure itself from the test's own side).
    expect(graph.get(ROOT_JOB_ID)).toHaveLength(1);
    expect(graph.get(hop1.receipt_id)).toHaveLength(1);
  }, 150_000);
});
