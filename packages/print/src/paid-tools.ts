import type { PaidTool } from "./siu-price.js";

/**
 * Where and how the paid tools can be paid for, live: the one source the server's mainnet profile
 * (packages/mcp-server/src/networks.ts) and every public page that describes payment read from —
 * the site's mcp.json, llms.txt and for-agents page, the marketing copies generated from them
 * (scripts/generate-agent-surfaces.mjs), and the facts block in docs/listing.md. A network
 * appears here only once its paid calls have been tested with real money (Base and Arc,
 * 2026-11-26). Kite is built but held back until its settler is funded and tested.
 */

export interface PaymentNetwork {
  name: string;
  /** CAIP-2 chain id, as x402's 402 response names it. */
  caip2: string;
  asset: "USDC";
  /** The USDC contract, from Circle's published USDC contract addresses. */
  assetAddress: string;
}

export const MAINNET_PAYMENT_NETWORKS: readonly PaymentNetwork[] = [
  {
    name: "Base",
    caip2: "eip155:8453",
    asset: "USDC",
    assetAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  {
    name: "Arc",
    caip2: "eip155:5042",
    asset: "USDC",
    assetAddress: "0x3600000000000000000000000000000000000000",
  },
];

/** What Dated SIU is, in the owner's words (2026-11-27). Every description below is built from it. */
export const DATED_SIU_PHRASE = "the daily benchmark price of verified AI work";

/** The one-line description every listing and mcp.json uses (owner's wording, 2026-11-27). */
export const LISTING_DESCRIPTION = `Dated SIU, ${DATED_SIU_PHRASE}: free index; paid quotes in USDC on Base and Arc mainnet.`;

/**
 * The same, within the MCP registry's 100-character limit for server.json's description (its schema,
 * ServerDetail.description maxLength 100): the owner's lead phrase verbatim, "paid" and "mainnet" cut.
 */
export const REGISTRY_DESCRIPTION = `Dated SIU, ${DATED_SIU_PHRASE}: free index; USDC quotes on Base and Arc.`;

/**
 * The prints site's <meta name="description">, on every page (site/src/render/layout.ts): what
 * search engines and link previews show. The method clause is the one the site carried before.
 */
export const SITE_DESCRIPTION = `Dated SIU, ${DATED_SIU_PHRASE}, measured by executing a versioned task basket, not by surveying list prices.`;

/** How a payment reaches the treasury on those networks. */
export const PAYMENT_ROUTE = "x402 through Circle Gateway (batched nanopayments)";

/** Paid tools not offered on mainnet yet, with the reason a caller is shown instead of a charge. */
export const MAINNET_UNAVAILABLE_TOOLS: Partial<Record<PaidTool, string>> = {
  verify_receipt:
    "verify_receipt is not available on mainnet yet: it reads escrow-backed settlements, which exist on testnet only, " +
    "and mainnet receipt attestation is not built. You were not charged.",
};

/** The same, as the public pages state it (MAINNET_UNAVAILABLE_TOOLS is what a caller is answered). */
export const MAINNET_UNAVAILABLE_NOTES: Partial<Record<PaidTool, string>> = {
  verify_receipt:
    "Not available on mainnet yet: mainnet receipt attestation is not built. A call to it there is answered without charge.",
};

/** Where the `touchstone` block each 402 offer carries (the price in mSIU) is documented. */
export const SIU_PRICE_DOCS_URL =
  "https://github.com/petrkrulis2022/dated-siu-inference/blob/main/packages/mcp-server/README.md#the-siu-price-in-every-402";

/** "USDC on Base (eip155:8453) and Arc (eip155:5042) mainnet, over x402 through Circle Gateway (batched nanopayments)". */
export function paymentNetworksText(): string {
  const names = MAINNET_PAYMENT_NETWORKS.map((n) => `${n.name} (${n.caip2})`);
  const list =
    names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return `USDC on ${list} mainnet, over ${PAYMENT_ROUTE}`;
}
