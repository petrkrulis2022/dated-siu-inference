import { secp256k1 } from "@noble/curves/secp256k1.js";
import type { Print } from "@datum/sdk";
import { validatePrint } from "@datum/sdk";
import { fromHex, printBodyHash, printBodyHashHex, toHex, type PrintBody } from "./canonicalise.js";

export const PUBLISHER_KEY_ENV = "DATUM_PUBLISHER_KEY";

export function loadPublisherKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[PUBLISHER_KEY_ENV];
  if (!key) {
    throw new Error(
      `${PUBLISHER_KEY_ENV} is not set. The publisher key signs the print; it is never committed ` +
        `and never defaulted — an unsigned or self-signed-with-a-dummy-key print would be worse ` +
        `than no print.`,
    );
  }
  return key;
}

export function publicKeyFor(privateKeyHex: string): string {
  return toHex(secp256k1.getPublicKey(fromHex(privateKeyHex), true));
}

/**
 * Signs a print body — build1-spec.md §6: canonicalise (JCS), hash (keccak256), sign
 * (secp256k1). The signature and public key are then written into the print file.
 *
 * `prehash: false` because the body hash is already a 32-byte keccak256 digest; letting the
 * curve hash it again would produce a signature over sha256(keccak256(body)), which no
 * independent verifier following the stated method would reproduce.
 */
export function signPrintBody(body: PrintBody, privateKeyHex: string): Print {
  const hash = printBodyHash(body);
  const signature = secp256k1.sign(hash, fromHex(privateKeyHex), { prehash: false });
  const print = {
    ...body,
    signature: toHex(signature),
    public_key: publicKeyFor(privateKeyHex),
  } as Print;

  // A signature is an attestation. Signing a body that does not satisfy the published print
  // schema would attest to something nobody can validate — e.g. a print with an empty
  // sensitivity block, which §6.7 requires and which would fail every downstream verifier.
  // Refuse at the point of signing rather than emitting an unpublishable signed artefact.
  const validation = validatePrint(print);
  if (!validation.valid) {
    throw new Error(
      `Refusing to sign a print that fails the published schema: ${validation.errors.join("; ")}`,
    );
  }

  return print;
}

export interface SignatureCheck {
  valid: boolean;
  bodyHash: string;
  reason?: string;
}

/** Re-checks a published print's signature against its own canonicalised body. */
export function verifyPrintSignature(print: Print): SignatureCheck {
  const bodyHash = printBodyHashHex(print);
  try {
    const valid = secp256k1.verify(
      fromHex(print.signature),
      fromHex(bodyHash),
      fromHex(print.public_key),
      { prehash: false },
    );
    return {
      valid,
      bodyHash,
      reason: valid ? undefined : "signature does not match the print body under its public key",
    };
  } catch (err) {
    return {
      valid: false,
      bodyHash,
      reason: `signature check threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
