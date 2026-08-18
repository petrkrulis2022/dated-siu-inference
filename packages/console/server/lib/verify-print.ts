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

export async function verifyPrintOnChain(
  print: Print,
  options: VerifyPrintOptions,
): Promise<PrintVerification> {
  const selfCheck = verifyPrint(print);
  const bodyHash = printBodyHashHex(print);

  try {
    const [publisher, postedAt] = await Promise.all([
      readAttestationPublisher(options.rpcUrl, options.attestationAddress),
      readAttestationPostedAt(options.rpcUrl, options.attestationAddress, bodyHash),
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
