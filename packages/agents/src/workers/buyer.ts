import { Hono } from "hono";
import { runBuyerDemo, type SellerEndpoint } from "../buyer.js";
import { clientsFor } from "../wallets.js";

/**
 * The Arc Testnet buyer Worker. `runBuyerDemo` already returns void and does everything by
 * side effect (real HTTP calls, real on-chain funding/settlement, a real verify_receipt call) —
 * unlike the CLI's `cli/agent-loop.ts`, which accumulates a step-by-step timing/result summary
 * around individual calls, `runBuyerDemo` is one already-built, already-live-verified (Phase C)
 * sequence covering discover→quote→compare→fund→settle→verify in one shot. This Worker wraps
 * that sequence with the same timed-step accumulation `agent-loop.ts` uses, rather than duplicate
 * runBuyerDemo's own internal logic, and returns the JSON summary from `POST /run`.
 *
 * Workers are event-triggered, not long-running processes — HTTP-triggered (`POST /run`) rather
 * than a cron, since a buyer loop is naturally invoked on demand (by cli/arc-worker-loop.ts, or
 * manually), not on a schedule.
 */

interface Env {
  CHAIN_NAME: string;
  RPC_URL: string;
  ESCROW_ADDRESS: string;
  USDC_ADDRESS: string;
  SELLER_A_URL: string;
  SELLER_B_URL: string;
  ARC_TESTBED_MCP_URL: string;
  MAX_USD_PER_QUOTE: string;
  BUYER_PRIVATE_KEY: string;
}

interface StepResult {
  step: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

const app = new Hono<{ Bindings: Env }>();

app.post("/run", async (c) => {
  const env = c.env;
  const results: StepResult[] = [];
  const log = (line: string) => {
    console.log(line);
    // runBuyerDemo logs each of its own internal steps through this callback — captured here as
    // one running detail string per invocation rather than re-deriving per-step timing, since
    // runBuyerDemo doesn't expose step boundaries itself (unlike agent-loop.ts's own timed()).
    results.push({ step: "runBuyerDemo", ok: true, latencyMs: 0, detail: line });
  };

  const sellers: [SellerEndpoint, SellerEndpoint] = [
    { label: "seller-a", url: env.SELLER_A_URL },
    { label: "seller-b", url: env.SELLER_B_URL },
  ];

  const start = Date.now();
  try {
    await runBuyerDemo({
      clients: clientsFor(env.BUYER_PRIVATE_KEY, env.RPC_URL),
      sellers,
      mandate: { max_usd_per_quote: env.MAX_USD_PER_QUOTE, accepted_chains: [env.CHAIN_NAME] },
      escrowAddress: env.ESCROW_ADDRESS,
      usdcAddress: env.USDC_ADDRESS,
      chainName: env.CHAIN_NAME,
      mcpServerUrl: env.ARC_TESTBED_MCP_URL,
      log,
    });
    return c.json({
      ok: true,
      latencyMs: Date.now() - start,
      log: results.map((r) => r.detail),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error("[buyer] /run failed:", detail);
    return c.json(
      {
        ok: false,
        latencyMs: Date.now() - start,
        error: detail,
        log: results.map((r) => r.detail),
      },
      500,
    );
  }
});

export default app;
