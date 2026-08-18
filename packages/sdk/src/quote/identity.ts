import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import type { SignatureCheck } from "../crypto/sign.js";
import { quoteHashHex, verifyQuoteSignature } from "./sign.js";

/**
 * `docs/datum-quote.md` states this normatively: a signature proves body integrity and key
 * custody only. Binding a public key to an ERC-8004 identity is out of scope for the build-1
 * spec and MUST be performed by the payer through a registry resolver before trusting
 * `seller_id` — this interface is that seam.
 */
export interface ResolvedIdentity {
  publicKey: string;
  /** Where the key came from — e.g. "static-allowlist". Surfaced so a caller can tell a real
   * registry lookup from a test/demo shortcut. */
  source: string;
}

export interface IdentityResolver {
  resolve(sellerId: string): Promise<ResolvedIdentity | null> | ResolvedIdentity | null;
}

/**
 * A local allowlist mapping `seller_id` to a public key — for the P14 demo agents (their own
 * sellers, known in advance) and for tests. Makes no claim about ERC-8004 at all.
 */
export class StaticResolver implements IdentityResolver {
  private readonly allowlist: Map<string, string>;

  constructor(entries: Record<string, string>) {
    this.allowlist = new Map(Object.entries(entries));
  }

  resolve(sellerId: string): ResolvedIdentity | null {
    const publicKey = this.allowlist.get(sellerId);
    return publicKey ? { publicKey, source: "static-allowlist" } : null;
  }
}

/**
 * Real ERC-8004 resolution is not implemented in build 1. Throwing here rather than returning
 * `null` is deliberate: `null` reads as "this seller has no identity", which is a false
 * statement — the truth is "this resolver cannot check". Wiring it needs: the registry contract
 * address, the chain it's deployed on, and the registry's lookup method for an `erc8004:...`
 * seller_id — none of which exist yet anywhere in this repo.
 */
export class Erc8004Resolver implements IdentityResolver {
  resolve(): never {
    throw new Error(
      "Erc8004Resolver is not implemented. Needs: the ERC-8004 registry contract address, " +
        "the chain it's deployed on, and the registry's lookup method for a seller_id of the " +
        'form "erc8004:...". Use StaticResolver until this is built.',
    );
  }
}

export interface QuoteIdentityCheck extends SignatureCheck {
  resolved: ResolvedIdentity | null;
}

/** Composes identity resolution with signature verification, so this seam is real code rather
 * than a TODO left for the mcp-server/agents milestones. */
export async function verifyQuoteFromIdentity(
  quote: TouchstoneQuote,
  resolver: IdentityResolver,
): Promise<QuoteIdentityCheck> {
  const resolved = await resolver.resolve(quote.seller_id);
  if (!resolved) {
    return {
      valid: false,
      bodyHash: quoteHashHex(quote),
      reason: `no identity resolved for seller_id "${quote.seller_id}"`,
      resolved: null,
    };
  }
  const check = verifyQuoteSignature(quote, resolved.publicKey);
  return { ...check, resolved };
}
