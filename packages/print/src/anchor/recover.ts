import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { fromHex, toHex } from "../sign/canonicalise.js";

/**
 * Recovers the EVM address(es) that could have produced a secp256k1 signature over a hash,
 * without trusting any public key embedded in the signed document.
 *
 * A print's own `public_key` field is exactly that kind of untrusted claim — nothing stops a
 * tampered file from carrying a signature and a public key that are internally consistent with
 * each other but belong to nobody real. `verifyPrintSignature` (sign/sign.ts) checks internal
 * consistency; this function is the other half, used to check the signature against a truth
 * that lives outside the file — `DatumAttestation.publisher()` on chain.
 *
 * The signatures this package produces (secp256k1.sign with `{ prehash: false }`) are the plain
 * 64-byte compact `{r, s}` form with no recovery bit attached — confirmed empirically against
 * the installed @noble/curves version, which returns exactly that shape. Recovery therefore
 * yields **two** candidate addresses (recovery ids 0 and 1), not one. That is not a weakness of
 * this check: exactly one of the two candidates will match the real signer for a real
 * signature, and the other is simply discarded. A verifier who finds neither candidate matches
 * has learned that the print was not signed by the claimed publisher, which is the point.
 */
export interface RecoveredCandidate {
  recoveryId: 0 | 1;
  publicKeyCompressed: string;
  address: string;
}

function addressFromCompressedPublicKey(compressed: Uint8Array): string {
  const point = secp256k1.Point.fromBytes(compressed);
  const uncompressed = point.toBytes(false);
  const digest = keccak_256(uncompressed.subarray(1));
  return toHex(digest.subarray(-20));
}

/**
 * @param signatureHex The 64-byte compact `{r,s}` signature, hex-encoded (a print's `signature`
 *        field, or a quote/receipt's).
 * @param bodyHashHex The 32-byte hash that was signed (a print's own `printBodyHashHex`).
 */
export function recoverSignerCandidates(
  signatureHex: string,
  bodyHashHex: string,
): RecoveredCandidate[] {
  const compact = fromHex(signatureHex);
  const hash = fromHex(bodyHashHex);
  if (compact.length !== 64) {
    throw new Error(`Expected a 64-byte compact signature, got ${compact.length} bytes.`);
  }

  const candidates: RecoveredCandidate[] = [];
  for (const recoveryId of [0, 1] as const) {
    const recoverable = new Uint8Array(65);
    recoverable[0] = recoveryId;
    recoverable.set(compact, 1);
    try {
      const publicKey = secp256k1.recoverPublicKey(recoverable, hash, { prehash: false });
      candidates.push({
        recoveryId,
        publicKeyCompressed: toHex(publicKey),
        address: addressFromCompressedPublicKey(publicKey),
      });
    } catch {
      // Not every recovery id yields a valid curve point for every {r,s,hash} triple. Skipping
      // an invalid candidate rather than throwing keeps the caller's loop simple; a genuine
      // signature always has at least one valid candidate.
    }
  }
  return candidates;
}

/**
 * The full independent-verification loop: does any recovered candidate match `expectedAddress`
 * (case-insensitive — EVM addresses have no canonical case in this comparison)?
 */
export function signatureMatchesAddress(
  signatureHex: string,
  bodyHashHex: string,
  expectedAddress: string,
): boolean {
  const target = expectedAddress.toLowerCase();
  return recoverSignerCandidates(signatureHex, bodyHashHex).some(
    (c) => c.address.toLowerCase() === target,
  );
}
