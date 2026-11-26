import type { APIRoute } from "astro";
import {
  FOR_AGENTS_URL,
  LIVE_PRICES_URL,
  MCP_SERVER_URL,
  MCP_TOOLS,
  PAYMENT_NETWORKS,
  PAYMENT_ROUTE,
  SIU_PRICE_DOCS_URL,
  SIU_PRICE_RULE,
} from "@/lib/mcp-info";

export const prerender = true;

// Mirrors prints.touchstoneassay.com/mcp.json: same server, same four tools, same prices and the
// same payment networks, all from @/lib/mcp-info.ts, whose facts are generated from the source the
// server's paywall reads (scripts/generate-agent-surfaces.mjs). This copy carries no mSIU figures:
// this site is not rebuilt each day, so it states the rule and links the live figures.

export const GET: APIRoute = () => {
  const body = {
    name: "io.github.petrkrulis2022/touchstone-mcp",
    description:
      "Dated SIU, the benchmark price of AI inference: free index; paid quotes in USDC on Base and Arc.",
    remote: {
      type: "streamable-http",
      url: MCP_SERVER_URL,
    },
    payment: {
      networks: PAYMENT_NETWORKS.map((n) => ({
        name: n.name,
        eip155: n.caip2,
        asset: n.asset,
        address: n.assetAddress,
      })),
      route: PAYMENT_ROUTE,
      siu_price: { rule: SIU_PRICE_RULE, docs: SIU_PRICE_DOCS_URL, live: LIVE_PRICES_URL },
    },
    tools: MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      price_usd: tool.priceUsd,
      free: tool.free,
      ...(tool.free ? {} : { available_on_mainnet: tool.mainnetNote === undefined }),
      ...(tool.mainnetNote ? { mainnet_note: tool.mainnetNote } : {}),
    })),
    repository: "https://github.com/petrkrulis2022/dated-siu-inference",
    docs: FOR_AGENTS_URL,
  };

  return new Response(JSON.stringify(body, null, 2), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
};
