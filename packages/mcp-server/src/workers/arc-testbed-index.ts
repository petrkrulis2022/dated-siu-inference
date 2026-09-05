import { Hono } from "hono";
import { TouchstoneMcpAgent } from "./mcp-agent.js";

// `Env` here is the same ambient global from worker-configuration.d.ts the real production
// deployment uses (this file lives in the same package/tsconfig) — it happens to carry
// production's own literal var values in its generated type (e.g. TOUCHSTONE_CHAIN_NAME typed
// as "base-sepolia"), but nothing in this file inspects or compares those values; `c.env` is
// only ever passed straight through to TouchstoneMcpAgent, so the literal-type mismatch with
// this deployment's own real wrangler.arc-testbed.jsonc values is harmless. TouchstoneMcpAgent
// itself is unmodified — reads BASE_SEPOLIA_RPC_URL/TOUCHSTONE_CHAIN_NAME/TOUCHSTONE_ESCROW_ADDRESS
// by these exact literal binding names regardless of which chain they actually point at, so this
// deployment's wrangler config keeps the same names, pointed at Arc Testnet instead — a real,
// harmless misnomer (see that config's own comment).

export { TouchstoneMcpAgent };

/**
 * The Arc-testbed MCP Worker — an isolated, unpaid deployment for exercising a real
 * `verify_receipt` against a live Arc Testnet TouchstoneEscrow, without touching or risking the
 * real, paid, production mcp.touchstoneassay.com deployment (workers/index.ts) at all. Same
 * routing shell as that file, but with the Circle Gateway paywall dispatch removed entirely —
 * every call forwards straight to the TouchstoneMcpAgent Durable Object, unconditionally. Not
 * reachable at a touchstoneassay.com custom domain — a workers.dev URL only, so it reads as
 * testbed infrastructure, not the real service. get_quote/convert are free here too (no paywall
 * at all in this deployment) — fine for a testbed whose only real consumer is the Arc buyer
 * Worker's own verify_receipt call, never presented as, or confused with, the real paid service.
 */
const app = new Hono<{ Bindings: Env }>();

app.post("/mcp", async (c) => {
  return TouchstoneMcpAgent.serve("/mcp", { binding: "TOUCHSTONE_MCP" }).fetch(
    c.req.raw,
    c.env,
    c.executionCtx as unknown as ExecutionContext,
  );
});

export default app;
