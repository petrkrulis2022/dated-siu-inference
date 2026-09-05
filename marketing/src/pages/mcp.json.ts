import type { APIRoute } from "astro";
import { MCP_SERVER_URL, MCP_TOOLS, SETTLEMENT_ASSET_ADDRESS } from "@/lib/mcp-info";

export const prerender = true;

// Mirrors site/static/mcp.json (prints.touchstoneassay.com) — same server, same four tools, same
// real prices, sourced from the shared @/lib/mcp-info.ts constant rather than hand-copied, so
// this file can't silently drift from llms.txt's own tool list the way two independently
// hand-authored copies could.

export const GET: APIRoute = () => {
  const body = {
    name: "io.github.petrkrulis2022/touchstone-mcp",
    description:
      "Dated SIU, the benchmark price of AI inference work: one free tool, three paid via x402.",
    remote: {
      type: "streamable-http",
      url: MCP_SERVER_URL,
    },
    network: {
      chain: "base-sepolia",
      eip155: "eip155:84532",
      note: "Testbed — Base Sepolia, not mainnet.",
    },
    settlement: {
      asset: "usdc",
      address: SETTLEMENT_ASSET_ADDRESS,
      scheme: "x402/exact via Circle Gateway (GatewayWalletBatched)",
    },
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      price_usd: tool.priceUsd,
      free: tool.free,
    })),
    repository: "https://github.com/petrkrulis2022/dated-siu-inference",
    // TODO(Phase 3): once marketing's own /for-agents page ships, point this at
    // https://touchstoneassay.com/for-agents instead — kept on the real, already-live page for
    // now so this link is never dead in the meantime.
    docs: "https://prints.touchstoneassay.com/for-agents.html",
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
