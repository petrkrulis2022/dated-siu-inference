import {
  LISTING_DESCRIPTION,
  MAINNET_UNAVAILABLE_NOTES,
  PAID_TOOL_PRICES_USD,
  PAYMENT_NETWORKS,
  PAYMENT_NETWORKS_TEXT,
  PAYMENT_ROUTE,
  SIU_PRICE_DOCS_URL,
  SIU_PRICE_RULE,
} from "./agent-facts.generated";

/**
 * Touchstone Assay's MCP server info on this site — reused by llms.txt.ts, mcp.json.ts, the
 * homepage's #builders teaser, and /for-agents. Prices, payment networks and the mainnet notes come
 * from ./agent-facts.generated.ts, which scripts/generate-agent-surfaces.mjs writes from the same
 * source the server's paywall and prints.touchstoneassay.com read (@touchstone/print), so this site
 * cannot drift from what the server accepts. Only the tool descriptions and URLs are written here.
 */

export const MCP_SERVER_URL = "https://mcp.touchstoneassay.com/mcp";
export const MCP_JSON_URL = "https://touchstoneassay.com/mcp.json";
export const LLMS_TXT_URL = "https://touchstoneassay.com/llms.txt";
export const FOR_AGENTS_URL = "https://touchstoneassay.com/for-agents";
/** The live mSIU figures (this site states the rule; the prints site states today's numbers). */
export const LIVE_PRICES_URL = "https://prints.touchstoneassay.com/mcp.json";

export const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "touchstone-assay": {
      "url": "${MCP_SERVER_URL}"
    }
  }
}`;

export interface McpToolInfo {
  name: string;
  description: string;
  priceUsd: string;
  free: boolean;
  /** Set when the tool is not offered on mainnet yet: what a reader is told instead. */
  mainnetNote?: string;
}

const paid = (name: keyof typeof PAID_TOOL_PRICES_USD, description: string): McpToolInfo => ({
  name,
  description,
  priceUsd: PAID_TOOL_PRICES_USD[name],
  free: false,
  ...(MAINNET_UNAVAILABLE_NOTES[name] ? { mainnetNote: MAINNET_UNAVAILABLE_NOTES[name] } : {}),
});

export const MCP_TOOLS: McpToolInfo[] = [
  {
    name: "get_index",
    description: "Returns the current signed Dated SIU print.",
    priceUsd: "0",
    free: true,
  },
  paid("get_quote", "SIU price and USD equivalent for one call of a task class against a model."),
  paid("convert", "SIU + USD equivalent for a specific token count against a model."),
  paid("verify_receipt", "Reads an on-chain settlement and returns a signed attestation of quoted vs. paid."),
];

/** One sentence on where payment settles, for pages that state it in prose. */
export const NETWORK_NOTE = `Paid tools settle in real ${PAYMENT_NETWORKS_TEXT}.`;

export { LISTING_DESCRIPTION, PAYMENT_NETWORKS, PAYMENT_ROUTE, SIU_PRICE_DOCS_URL, SIU_PRICE_RULE };
