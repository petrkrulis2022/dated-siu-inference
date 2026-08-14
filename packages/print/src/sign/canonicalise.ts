import canonicalizeDefault from "canonicalize";
import { keccak_256 } from "@noble/hashes/sha3.js";
import type { Print } from "@datum/sdk";

export type PrintBody = Omit<Print, "signature" | "public_key">;

/**
 * RFC 8785 (JSON Canonicalisation Scheme). Two independent implementations must serialise the
 * same print to the same bytes, or the signature is unverifiable by anyone but us — which
 * would defeat the point of publishing it.
 */
export function canonicalise(body: unknown): string {
  const result = canonicalizeDefault(body);
  if (result === undefined) {
    throw new Error("Print body is not canonicalisable (contains undefined or a cycle).");
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

/**
 * Strips the signature fields before canonicalising: a signature cannot cover itself. The
 * signed bytes are the print body exactly as published, minus `signature` and `public_key`.
 */
export function printBodyOf(print: Print | PrintBody): PrintBody {
  const copy = { ...(print as Print) } as Partial<Print>;
  delete copy.signature;
  delete copy.public_key;
  return copy as PrintBody;
}

/** keccak256 of the JCS-canonicalised print body — build1-spec.md §6 "Signing". */
export function printBodyHash(body: Print | PrintBody): Uint8Array {
  return keccak_256(new TextEncoder().encode(canonicalise(printBodyOf(body))));
}

export function printBodyHashHex(body: Print | PrintBody): string {
  return toHex(printBodyHash(body));
}
