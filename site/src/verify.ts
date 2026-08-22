import type { Print } from "@touchstone/sdk";
import { printBodyHashHex, recoverSignerCandidates } from "@touchstone/print";

export interface VerifyInfo {
  bodyHash: string;
  recoveredSigner: string;
  publisherAddress: string;
  matchesPublisher: boolean;
}

/**
 * Pure, offline, build-time computation — same inputs `verify-onchain.ts` and the console's
 * `verify-print.ts` use, minus the live RPC read. `publisherAddress` comes from
 * data/deployments/*.json (the immutable constructor arg TouchstoneAttestation was deployed
 * with — safe to state as fact, not a live claim, since the contract has no publisher-rotation
 * path), not from an on-chain call this static build can't make.
 */
export function buildVerifyInfo(print: Print, publisherAddress: string): VerifyInfo {
  const bodyHash = printBodyHashHex(print);
  const candidates = recoverSignerCandidates(print.signature, bodyHash);
  const matched = candidates.find(
    (c) => c.address.toLowerCase() === publisherAddress.toLowerCase(),
  );
  return {
    bodyHash,
    recoveredSigner: matched?.address ?? candidates[0]?.address ?? "",
    publisherAddress,
    matchesPublisher: Boolean(matched),
  };
}
