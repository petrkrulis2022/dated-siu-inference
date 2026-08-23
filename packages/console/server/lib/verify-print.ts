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
  options: VerifyPrintOptions,
): Promise<PrintVerification> {
  const selfCheck = verifyPrint(print);
  const bodyHash = printBodyHashHex(print);

  try {
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
