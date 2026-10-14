/**
 * How to verify a print, written once for the human page and for the machine-readable `verify.json`, so the two cannot disagree. The list of removed fields is
 * the same five `packages/print`'s `printBodyOf` removes; a test builds a print carrying all five and checks the code removes exactly these.
 */
import type { ChainInfo } from "./data.js";

/** Removed before hashing. `anchor`, `superseded_by` and `correction_notes` are written after signing, so they cannot be part of what was signed. */
export const EXCLUDED_FIELDS = ["signature", "public_key", "anchor", "superseded_by", "correction_notes"] as const;

export const SITE_URL = "https://prints.touchstoneassay.com";
export const RAW_PRINT_URL = "https://raw.githubusercontent.com/petrkrulis2022/dated-siu-inference/main/data/prints/";
export const VERIFY_SCRIPT_URL = `${SITE_URL}/verify-print.mjs`;
export const VERIFY_JSON_URL = `${SITE_URL}/verify.json`;

export const ATTESTATION_ABI = [
  "function publisher() view returns (address)",
  "function postedAt(bytes32 bodyHash) view returns (uint64)",
  "function isPosted(bytes32 bodyHash) view returns (bool)",
  "event PrintPosted(bytes32 indexed bodyHash, string version, uint64 timestamp)",
] as const;

/** The chain's name as the page shows it. */
export const chainName = (c: ChainInfo): string => c.name ?? "Base Sepolia";
export const chainSlug = (c: ChainInfo): string => c.slug ?? "base-sepolia";

export interface VerificationExample {
  print_id: string;
  body_hash: string;
  /** The anchor the print itself carries, so an agent can test its own implementation end to end. */
  anchor?: { chain: string; tx_hash: string };
}

/** The machine-readable counterpart to the page's "Verify this yourself" section. Everything an agent needs to check a print with no human in the loop. */
export function buildVerificationSpec(input: { chains: readonly ChainInfo[]; example?: VerificationExample }): Record<string, unknown> {
  return {
    spec: "touchstone-print-verification",
    version: 1,
    what_it_proves:
      "That a print's published JSON existed, byte for byte in its canonical form, no later than the block time a chain's TouchstoneAttestation contract recorded for its hash. " +
      "It does not prove the print's numbers are right: the contract never computes or checks a print.",
    print: {
      raw_url_template: `${RAW_PRINT_URL}{print_id}.json`,
      index_url: `${RAW_PRINT_URL}index.json`,
      page_url_template: `${SITE_URL}/prints/{print_id}`,
    },
    body_hash: {
      remove_fields: [...EXCLUDED_FIELDS],
      canonicalisation: "RFC 8785 JSON Canonicalization Scheme (JCS) of the remaining object",
      hash: "keccak256 (the original Keccak padding Ethereum uses, not NIST SHA3-256) of the UTF-8 bytes of the canonical text",
      output: "0x followed by 64 lowercase hexadecimal digits",
    },
    signature: {
      scheme: "secp256k1, a 64-byte compact signature over the 32-byte body hash with no further hashing (prehash false)",
      public_key: "the print's public_key field, a compressed secp256k1 key",
      expected_signer:
        "keccak256 of the uncompressed public key, last 20 bytes, must equal each chain's publisher address below. The signature carries no recovery id, so try both and accept if either recovers that address.",
    },
    chains: input.chains.map((c) => ({
      slug: chainSlug(c),
      name: chainName(c),
      ...(c.chainId !== undefined ? { chain_id: c.chainId } : {}),
      explorer: c.explorerBaseUrl,
      attestation_contract: c.attestationAddress,
      contract_url: `${c.explorerBaseUrl}/address/${c.attestationAddress}`,
      publisher: c.publisherAddress,
      publisher_immutable: true,
      anchoring: c.anchoringLive === false ? "not yet live: the contract is deployed and no print has been anchored on it" : "live: every print is anchored here",
      abi: [...ATTESTATION_ABI],
    })),
    steps: [
      "1. GET the print JSON (print.raw_url_template).",
      "2. Remove body_hash.remove_fields. Keep every other field exactly as published.",
      "3. Canonicalise the rest as JCS, then take keccak256 of its UTF-8 bytes. That is the body hash.",
      "4. Optional: check the signature as described under signature.",
      "5. For each chain in which the print has an anchor transaction (the print's own anchor field names the chain and tx_hash): " +
        "GET {explorer}/api/v2/transactions/{tx_hash}/logs. Find the log whose address equals that chain's attestation_contract and whose decoded " +
        "PrintPosted event has bodyHash equal to yours. Its timestamp parameter is the block time (Unix seconds) at which the hash was first recorded.",
      "6. Alternatively call postedAt(bodyHash) on the contract through any RPC for that chain: a non-zero value is the same timestamp, zero means never anchored.",
    ],
    run_it_for_you: {
      script_url: VERIFY_SCRIPT_URL,
      command: "curl -O " + VERIFY_SCRIPT_URL + " && node verify-print.mjs {print_id}",
      requirements: "Node 18 or later. No npm install, no keys. Exit code 0 only if the hash was computed and an anchor it could check matched.",
      does_not_check: "the signature",
    },
    ...(input.example !== undefined ? { worked_example: input.example } : {}),
  };
}
