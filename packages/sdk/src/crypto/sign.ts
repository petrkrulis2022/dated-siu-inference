import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bodyHash, fromHex, toHex } from "./canonicalise.js";

/**
 * Generic secp256k1 sign/verify over a JCS-canonicalised, keccak256-hashed body — the same
 * scheme `@touchstone/print` uses for prints (build1-spec.md §6), reused here so quotes and receipts
 * are signed and verified the same way. `quote/sign.ts` and `receipt/sign.ts` build on this with
 * their own body-shape stripping (excluding `sig`, or `signature`/`public_key`) and their own
 * schema validation.
 */

export function publicKeyFor(privateKeyHex: string): string {
  return toHex(secp256k1.getPublicKey(fromHex(privateKeyHex), true));
}

/** `prehash: false` — the body hash is already a 32-byte keccak256 digest; re-hashing it would
 * produce a signature no independent verifier following the stated method would reproduce. */
export function signBodyHash(hash: Uint8Array, privateKeyHex: string): string {
  return toHex(secp256k1.sign(hash, fromHex(privateKeyHex), { prehash: false }));
}

export interface SignatureCheck {
  valid: boolean;
  bodyHash: string;
  reason?: string;
}

export function verifyBodySignature(
  body: unknown,
  signatureHex: string,
  publicKeyHex: string,
): SignatureCheck {
  const hashHex = toHex(bodyHash(body));
  try {
    const valid = secp256k1.verify(fromHex(signatureHex), fromHex(hashHex), fromHex(publicKeyHex), {
      prehash: false,
    });
    return {
      valid,
      bodyHash: hashHex,
      reason: valid ? undefined : "signature does not match the body under its public key",
    };
  } catch (err) {
    return {
      valid: false,
      bodyHash: hashHex,
      reason: `signature check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
