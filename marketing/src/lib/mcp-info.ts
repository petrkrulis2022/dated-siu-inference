/**
 * The one source of truth for Touchstone Assay's MCP server info on this site — reused by
 * llms.txt.ts, mcp.json.ts, the homepage's #builders teaser, and /for-agents. Mirrors
 * site/static/mcp.json (prints.touchstoneassay.com) exactly: same server, same four tools, same
 * real prices. Keep both in sync by hand until a shared package makes that unnecessary — same
 * caveat site/'s own for-agents-page.ts already carries for its three hand-authored copies.
 */

export const MCP_SERVER_URL = "https://mcp.touchstoneassay.com/mcp";
export const MCP_JSON_URL = "https://touchstoneassay.com/mcp.json";
export const LLMS_TXT_URL = "https://touchstoneassay.com/llms.txt";
export const FOR_AGENTS_URL = "https://touchstoneassay.com/for-agents";

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
}

export const MCP_TOOLS: McpToolInfo[] = [
  {
    name: "get_index",
    description: "Returns the current signed Dated SIU print.",
    priceUsd: "0",
    free: true,
  },
  {
    name: "get_quote",
    description: "SIU price and USD equivalent for one call of a task class against a model.",
    priceUsd: "0.001",
    free: false,
  },
  {
    name: "convert",
    description: "SIU + USD equivalent for a specific token count against a model.",
    priceUsd: "0.001",
    free: false,
  },
  {
    name: "verify_receipt",
    description: "Reads an on-chain settlement and returns a signed attestation of quoted vs. paid.",
    priceUsd: "0.01",
    free: false,
  },
];

export const NETWORK_NOTE = "Testbed — Base Sepolia, not mainnet.";
export const SETTLEMENT_ASSET_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
