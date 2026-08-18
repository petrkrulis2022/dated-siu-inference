import { join } from "node:path";
import { loadDeployment } from "@touchstone/sdk";
import { printBodyHashHex } from "../sign/canonicalise.js";
import { recoverSignerCandidates } from "../anchor/recover.js";
import { readAttestationPostedAt, readAttestationPublisher } from "../anchor/on-chain.js";
import { loadPrint, printsDir } from "./load-inputs.js";

/**
 * Independent verification, closing the loop `docs/methodology.md`'s "Publisher signing key"
 * section describes: a print's own `signature`/`public_key` fields prove internal consistency
 * (see `verify.ts`) but say nothing about whether the signer is really Touchstone Assay, since a tampered
 * file could carry a self-consistent signature over a different key. This command needs no
 * `TOUCHSTONE_PUBLISHER_KEY` and trusts nothing the print file claims about itself:
 *
 *   1. Recompute the print's body hash independently.
 *   2. Recover the signer's address from the raw {signature, hash} pair — not read from the
 *      file's own `public_key` field.
 *   3. Compare that recovered address against `TouchstoneAttestation.publisher()`, read live from
 *      the chain.
 *   4. Confirm the same body hash is anchored on-chain (`postedAt(bodyHash) > 0`).
 *
 * Usage: verify-onchain <print-id | path-to-print.json> [network]
 *   network defaults to $TOUCHSTONE_CHAIN_NAME, or "base-sepolia".
 * Env: <NETWORK>_RPC_URL, e.g. BASE_SEPOLIA_RPC_URL for network "base-sepolia".
 */
const target = process.argv[2];
if (!target) {
  console.error("Usage: verify-onchain <print-id | path-to-print.json> [network]");
  process.exit(1);
}

const network = process.argv[3] ?? process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
const rpcEnvVar = `${network.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
const rpcUrl = process.env[rpcEnvVar];
if (!rpcUrl) {
  console.error(`${rpcEnvVar} is not set — cannot read from ${network}.`);
  process.exit(1);
}

const path = target.endsWith(".json") ? target : join(printsDir(), `${target}.json`);
const print = await loadPrint(path);
const bodyHash = printBodyHashHex(print);

console.log(`Print:        ${print.print_id}`);
console.log(`Body hash:    ${bodyHash}`);
console.log(`Network:      ${network}`);
console.log();

const deployment = loadDeployment(network);
const attestationAddress = deployment.contracts.TouchstoneAttestation.address;
console.log(`TouchstoneAttestation: ${attestationAddress}`);

const [publisher, postedAt] = await Promise.all([
  readAttestationPublisher(rpcUrl, attestationAddress),
  readAttestationPostedAt(rpcUrl, attestationAddress, bodyHash),
]);

const candidates = recoverSignerCandidates(print.signature, bodyHash);
const matched = candidates.find((c) => c.address.toLowerCase() === publisher.toLowerCase());

console.log();
console.log(`On-chain publisher():        ${publisher}`);
console.log(`Recovered signer candidates: ${candidates.map((c) => c.address).join(", ")}`);
console.log(
  matched
    ? `  -> MATCH (recovery id ${matched.recoveryId}): this print was signed by the on-chain publisher.`
    : `  -> NO MATCH: this print was NOT signed by the on-chain publisher. Do not trust it.`,
);

console.log();
console.log(`postedAt(bodyHash): ${postedAt}`);
console.log(
  postedAt > 0n
    ? `  -> ANCHORED at ${new Date(Number(postedAt) * 1000).toISOString()}`
    : `  -> NOT ANCHORED on this network.`,
);

const verified = Boolean(matched) && postedAt > 0n;
console.log();
console.log(
  verified
    ? "VERIFIED: signature matches the on-chain publisher AND the hash is anchored."
    : "NOT VERIFIED.",
);
process.exit(verified ? 0 : 1);
