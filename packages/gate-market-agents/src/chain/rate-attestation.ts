import { keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Print } from "@touchstone/sdk";

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
 *
 * `series`/`printDate` added 2026-09-27, same day as `WorkClaim.ClaimType.series` — grade was
 * previously unmodeled anywhere in this testbed, so nothing stopped a frontier claim from
 * default-settling against a blended or commodity rate. Field order here must match
 * `RateAttestationVerifier.sol`'s own `RATE_ATTESTATION_TYPEHASH` exactly (EIP-712 typed-data
 * hashing is order-sensitive).
 */
export interface RateAttestation {
  printId: string;
  series: Hex;
  printDate: bigint;
  nanoUsdPerSiu: bigint;
  validUntil: bigint;
}

const DOMAIN_NAME = "Touchstone Rate Attestation";
const DOMAIN_VERSION = "1";

const TYPES = {
  RateAttestation: [
    { name: "printId", type: "string" },
    { name: "series", type: "bytes32" },
    { name: "printDate", type: "uint64" },
    { name: "nanoUsdPerSiu", type: "uint256" },
    { name: "validUntil", type: "uint64" },
  ],
} as const;

/** `keccak256("frontier")`/`keccak256("commodity")` — must match `WorkClaim.sol`'s own
 * `SERIES_FRONTIER`/`SERIES_COMMODITY` public constants exactly (same construction
 * `classIdFor` in `loop/full-run.ts` already uses for task class: `keccak256` of the plain UTF-8
 * string bytes, not `abi.encode`d). */
export const SERIES_FRONTIER: Hex = keccak256(stringToBytes("frontier"));
export const SERIES_COMMODITY: Hex = keccak256(stringToBytes("commodity"));

/** `Print.series` ("frontier"/"commodity") to the matching on-chain constant — throws for a
 * blended print (`series` absent), since a blended Dated SIU print backs no WorkClaim: every
 * real claim in this testbed has a grade, and a rate attestation must name one. */
export function seriesForPrint(series: "frontier" | "commodity" | undefined): Hex {
  if (series === "frontier") return SERIES_FRONTIER;
  if (series === "commodity") return SERIES_COMMODITY;
  throw new Error(
    `seriesForPrint: print has no series (a blended Dated SIU print backs no WorkClaim) — ` +
      `pass a print's own "-frontier"/"-commodity" series print instead.`,
  );
}

/** Unix timestamp of 00:00:00 UTC on a print's own calendar `date` ("YYYY-MM-DD") — the
 * granularity `RateAttestation.printDate`/`WorkClaim._dayStart` compare at. */
export function printDateToUnixDay(date: string): bigint {
  const [year, month, day] = date.split("-").map(Number);
  return BigInt(Date.UTC(year, month - 1, day) / 1000);
}

/** Truncates a raw Unix timestamp (seconds) down to 00:00:00 UTC of its own calendar day —
 * mirrors `WorkClaim.sol`'s own private `_dayStart` exactly. For a caller that has a claim's own
 * `windowTo` (a real testbed's default date) rather than a print's own `date` string. */
export function unixDayStart(timestampSeconds: bigint): bigint {
  return timestampSeconds - (timestampSeconds % 86_400n);
}

/** USD-per-SIU decimal string (e.g. a print's own `dated_siu`) to nano-USD-per-SIU, matching
 * `RateAttestationVerifier.sol`'s own 1e9 scale exactly — no floats: parses the decimal string's
 * own integer and fractional parts directly rather than via floating-point arithmetic. */
export function usdPerSiuToNanoUsdPerSiu(usdPerSiu: string): bigint {
  const [whole, fraction = ""] = usdPerSiu.split(".");
  const fractionPadded = (fraction + "0".repeat(9)).slice(0, 9);
  return BigInt(whole) * 1_000_000_000n + BigInt(fractionPadded || "0");
}

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

/**
 * Signs a real rate attestation for one real, published grade print — "the print pipeline's
 * attestation emission" the 2026-09-27 design review asked for: derives `series` from
 * `print.series` (throws for a blended print — see `seriesForPrint`), `printDate` from
 * `print.date`, and `nanoUsdPerSiu` from `print.dated_siu`, rather than a caller assembling those
 * three fields by hand from a print object every time. One call signs one series' attestation for
 * one print; not a background service, just the one conversion every real caller needs.
 */
export async function signRateAttestationForPrint(
  print: Print,
  validitySeconds: bigint,
  chainId: number,
  verifyingContract: Hex,
  privateKeyHex: Hex,
): Promise<{ attestation: RateAttestation; signature: Hex }> {
  const attestation: RateAttestation = {
    printId: print.print_id,
    series: seriesForPrint(print.series),
    printDate: printDateToUnixDay(print.date),
    nanoUsdPerSiu: usdPerSiuToNanoUsdPerSiu(print.dated_siu),
    validUntil: BigInt(Math.floor(Date.now() / 1000)) + validitySeconds,
  };
  const signature = await signRateAttestation(attestation, chainId, verifyingContract, privateKeyHex);
  return { attestation, signature };
}
