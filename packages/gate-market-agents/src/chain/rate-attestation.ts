import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Signs the same EIP-712 `RateAttestation` message `RateAttestationVerifier.sol`
 * (`packages/contracts/src`) verifies — see that contract's own doc comment for what this does
 * and doesn't guarantee. Mirrors `packages/print/src/sign/sign.ts`'s shape deliberately: same
 * real key (`TOUCHSTONE_PUBLISHER_KEY`), a different message-hashing scheme (EIP-712 typed data,
 * not the print's own raw JCS-body-hash signature) — domain-separated by construction, so reusing
 * the one key for both is safe, not a shortcut.
 *
 * `domain.name`/`domain.version` must match `WorkClaim`'s own constructor call
 * (`RateAttestationVerifier(publisher_, "Touchstone Rate Attestation", "1")`) exactly, or a
 * signature produced here will simply fail to recover to `publisher` on-chain — not a partial or
 * silently-degraded verification, a clean revert.
 */
export interface RateAttestation {
  printId: string;
  nanoUsdPerSiu: bigint;
  validUntil: bigint;
}

const DOMAIN_NAME = "Touchstone Rate Attestation";
const DOMAIN_VERSION = "1";

const TYPES = {
  RateAttestation: [
    { name: "printId", type: "string" },
    { name: "nanoUsdPerSiu", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

/** `verifyingContract` must be the real, deployed `WorkClaim` address the signature will be
 * presented to — part of the EIP-712 domain, so a signature for one deployment does not recover
 * correctly against another. */
export async function signRateAttestation(
  attestation: RateAttestation,
  chainId: number,
  verifyingContract: Hex,
  privateKeyHex: Hex,
): Promise<Hex> {
  const account = privateKeyToAccount(privateKeyHex);
  return account.signTypedData({
    domain: { name: DOMAIN_NAME, version: DOMAIN_VERSION, chainId, verifyingContract },
    types: TYPES,
    primaryType: "RateAttestation",
    message: attestation,
  });
}

/** The publisher address a given private key would sign as — for a deploy script or test setup
 * that needs to configure `WorkClaim`'s immutable `publisher` before any attestation is signed. */
export function rateAttestationPublisherAddress(privateKeyHex: Hex): Hex {
  return privateKeyToAccount(privateKeyHex).address;
}
