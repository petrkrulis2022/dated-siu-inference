import { publicKeyFor, StaticResolver, type IdentityResolver } from "@touchstone/sdk";

/**
 * WP-4's "ERC-8004 identity record" per agent, reusing the existing seam rather than a real
 * on-chain registry: `packages/sdk/src/quote/identity.ts`'s `StaticResolver` is what quote
 * verification actually uses today, and `erc8004:0xADDRESS` is the same string convention
 * `packages/agents/src/seller.ts`'s `sellerIdFor()` already builds. A real ERC-8004 registry was
 * explicitly deferred by the user (2026-09-19, "we do it later") and nothing since has
 * un-deferred it — see `packages/sdk/src/quote/identity.ts`'s `Erc8004Resolver`, which throws
 * rather than fabricates a resolution, for the same reason this file does not attempt one.
 */
export const AGENT_IDS = [
  "ISSUER-A",
  "ISSUER-B",
  "ORCHESTRATOR",
  "WORKER-CODE",
  "WORKER-EXTRACT",
  "HEDGER",
] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export function erc8004IdFor(address: string): string {
  return `erc8004:${address}`;
}

/**
 * Builds the seller_id -> public key allowlist every agent's own `StaticResolver` needs to
 * verify a quote issued by any other agent in the roster. `privateKeyHexByAgent` supplies each
 * agent's raw secp256k1 private key (the same key `Runner` uses for both on-chain txs and quote
 * signing — see `runner.ts`) — never logged, never returned, used only to derive the public key.
 */
export function buildAgentRosterResolver(
  privateKeyHexByAgent: Partial<Record<AgentId, string>>,
  addressByAgent: Partial<Record<AgentId, string>>,
): IdentityResolver {
  const entries: Record<string, string> = {};
  for (const agentId of AGENT_IDS) {
    const privateKeyHex = privateKeyHexByAgent[agentId];
    const address = addressByAgent[agentId];
    if (!privateKeyHex || !address) continue;
    entries[erc8004IdFor(address)] = publicKeyFor(privateKeyHex);
  }
  return new StaticResolver(entries);
}
