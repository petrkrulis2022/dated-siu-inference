import type { Print } from "@touchstone/sdk";
import {
  verifyPrint,
  printBodyHashHex,
  recoverSignerCandidates,
  readAttestationPublisher,
  readAttestationPostedAt,
} from "@touchstone/print";

/**
 * The exact closed loop `packages/print/src/cli/verify-onchain.ts` already runs, composed here
 * from the same exported functions rather than reimplemented — computed live, per request, never
 * cached as a stored flag, per the console's own explicit requirement. Read-only: every call
 * below is a chain read (`readContract`), never a write.
 */
export interface PrintVerification {
  schemaValid: boolean;
  signatureSelfConsistent: boolean;
  onChainPublisher: string | null;
  recoveredSigner: string | null;
  matchesOnChainPublisher: boolean;
  anchored: boolean;
  postedAtUnix: string | null;
  verified: boolean;
  error?: string;
}

export interface VerifyPrintOptions {
  rpcUrl: string;
  attestationAddress: string;
}

/**
 * `resolveOptions` is a thunk, not a plain value, specifically so a caller resolves it against
 * *this print's own* `anchor.chain` (`../config.js`'s `resolveVerifyOptions`) rather than always
 * the console's single configured default chain — a print anchored elsewhere would otherwise
 * read as "unverified" simply because the wrong chain's TouchstoneAttestation was asked about a
 * bodyHash it never received, indistinguishable from a genuine anchoring failure.
 */

/**
 * The two on-chain reads below hit a shared public RPC endpoint (sepolia.base.org — see
 * data/deployments/base-sepolia.json), and the static console build fires a burst of them in a
 * short window (two reads per print, across every print, plus the indexer's own calls). A single
 * transient 429/timeout there previously surfaced as a permanent "chain read failed" badge on an
 * otherwise-correctly-anchored print, baked into the static build until the next redeploy. Retrying
 * is safe here because these are side-effect-free reads, unlike the write path in
 * ./anchor/attestation.ts.
 */
async function withRetry<T>(read: () => Promise<T>, attempts = 3, delayMs = 800): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await read();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

export async function verifyPrintOnChain(
  print: Print,
  resolveOptions: () => VerifyPrintOptions,
): Promise<PrintVerification> {
  const selfCheck = verifyPrint(print);
  const bodyHash = printBodyHashHex(print);

  try {
    // Resolving inside the try, not before it: a print anchored on a chain this console has no
    // RPC URL/deployment file for should report the same honest "verification failed, here's
    // why" shape as a chain-read failure would, not throw past the caller's own error handling.
    const options = resolveOptions();
    const [publisher, postedAt] = await Promise.all([
      withRetry(() => readAttestationPublisher(options.rpcUrl, options.attestationAddress)),
      withRetry(() => readAttestationPostedAt(options.rpcUrl, options.attestationAddress, bodyHash)),
    ]);
    const candidates = recoverSignerCandidates(print.signature, bodyHash);
    const matched = candidates.find((c) => c.address.toLowerCase() === publisher.toLowerCase());

    return {
      schemaValid: selfCheck.schemaValid,
      signatureSelfConsistent: selfCheck.signatureValid,
      onChainPublisher: publisher,
      recoveredSigner: matched?.address ?? candidates[0]?.address ?? null,
      matchesOnChainPublisher: Boolean(matched),
      anchored: postedAt > 0n,
      postedAtUnix: postedAt > 0n ? postedAt.toString() : null,
      verified: selfCheck.schemaValid && Boolean(matched) && postedAt > 0n,
    };
  } catch (err) {
    return {
      schemaValid: selfCheck.schemaValid,
      signatureSelfConsistent: selfCheck.signatureValid,
      onChainPublisher: null,
      recoveredSigner: null,
      matchesOnChainPublisher: false,
      anchored: false,
      postedAtUnix: null,
      verified: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
