import canonicalizeDefault from "canonicalize";
import { keccak_256 } from "@noble/hashes/sha3.js";

/**
 * A second, deliberately-duplicated copy of `@datum/print`'s canonicalisation primitives
 * (`packages/print/src/sign/canonicalise.ts`) — not an import, because `@datum/print` depends
 * on `@datum/sdk`, never the reverse. `packages/print/src/divergence.test.ts` asserts the two
 * stay byte-identical.
 *
 * RFC 8785 (JSON Canonicalisation Scheme). Two independent implementations must serialise the
 * same body to the same bytes, or a signature over it is unverifiable by anyone but us — which
 * would defeat the point of publishing it.
 */
export function canonicalise(body: unknown): string {
  const result = canonicalizeDefault(body);
  if (result === undefined) {
    throw new Error("Body is not canonicalisable (contains undefined or a cycle).");
  }
  return result;
}

export function toHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) {
    throw new Error(`Invalid hex string (odd length): ${hex}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** keccak256 of the JCS-canonicalised body. */
export function bodyHash(body: unknown): Uint8Array {
  return keccak_256(new TextEncoder().encode(canonicalise(body)));
}

export function bodyHashHex(body: unknown): string {
  return toHex(bodyHash(body));
}
