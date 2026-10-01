import { loadDeployment, type DeploymentRecord } from "@touchstone/sdk";
import { OnChainSettlementReader } from "./settlement/on-chain.js";
import type { SettlementReader } from "./settlement/reader.js";

/**
 * Deliberately NOT the same key `packages/print` signs prints and anchors with. This is a
 * public-facing service — putting a key that can anchor on-chain records on it would mean a
 * compromised Worker could forge anchored history, not just forge unanchored receipts. A
 * dedicated attestation key has no relationship to TOUCHSTONE_PUBLISHER_KEY (different value,
 * generated independently) and can only ever sign the small ReceiptBody JSON verify_receipt
 * builds — it never anchors anything, never holds funds, never signs a transaction.
 */
export const ATTESTATION_KEY_ENV = "TOUCHSTONE_ATTESTATION_KEY";
export const SELLER_ADDRESS_ENV = "TOUCHSTONE_SELLER_ADDRESS";
export const CHAIN_NAME_ENV = "TOUCHSTONE_CHAIN_NAME";

/**
 * What these loaders accept, and why it is not `EnvLike`.
 *
 * `wrangler types` generates `worker-configuration.d.ts` — git-tracked — which augments the
 * GLOBAL `EnvLike` with this Worker's vars as string LITERALS, not strings:
 *
 *     TOUCHSTONE_SELLER_ADDRESS: "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e";
 *     TOUCHSTONE_CHAIN_NAME: "base-sepolia";
 *
 * Typing a parameter as `EnvLike` therefore drags one deployment's values into the
 * signature. No test could pass a different address, and more seriously the type asserts that
 * the chain IS "base-sepolia" — so a future `if (env[CHAIN_NAME_ENV] === "arc-testnet")` types
 * as `never` and narrows away. CLAUDE.md's rule is that nothing carries chain-specific
 * assumptions so Arc stays a deployment target rather than a rewrite; a literal type saying
 * otherwise is exactly that assumption, hardened where nobody would look for it.
 *
 * A plain record is what these functions actually need: a bag of optional strings.
 */
export type EnvLike = Record<string, string | undefined>;

export function loadAttestationKeyFromEnv(env: EnvLike = process.env): string {
  const key = env[ATTESTATION_KEY_ENV];
  if (!key) {
    throw new Error(
      `${ATTESTATION_KEY_ENV} is not set. verify_receipt signs with a dedicated attestation ` +
        `key — separate from TOUCHSTONE_PUBLISHER_KEY, which this service never touches — and ` +
        `there is no default to fall back to.`,
    );
  }
  return key;
}

/** The EVM wallet address Circle's Gateway middleware pays out to — build1-spec.md §9. */
export function loadSellerAddressFromEnv(env: EnvLike = process.env): string {
  const address = env[SELLER_ADDRESS_ENV];
  if (!address) {
    throw new Error(
      `${SELLER_ADDRESS_ENV} is not set. The Gateway paywall needs a real wallet address to ` +
        `receive USDC payments; there is no sensible default to fall back to.`,
    );
  }
  return address;
}

/**
 * Builds the real `SettlementReader` for `verify_receipt`, resolving `TouchstoneEscrow`'s address
 * from `data/deployments/<chain>.json` (@touchstone/sdk's `loadDeployment`) rather than hardcoding it
 * here — the deployment record is canonical, this is just a caller of it (README's Deployments
 * section is the other caller, generated the same way).
 */
export function loadSettlementReaderFromEnv(
  env: EnvLike = process.env,
): SettlementReader {
  const chainName = env[CHAIN_NAME_ENV] ?? "base-sepolia";
  const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  const rpcUrl = env[rpcEnvVar];
  if (!rpcUrl) {
    throw new Error(
      `${rpcEnvVar} is not set — cannot read on-chain settlements for chain "${chainName}".`,
    );
  }
  // Optional — see OnChainSettlementReaderOptions.archiveRpcUrl's own doc comment. Absent means
  // verify_receipt falls back to rpcUrl, which is fine for a recent settlement and will start
  // failing only for one old enough that the public endpoint has pruned its block.
  const archiveRpcEnvVar = `TOUCHSTONE_${chainName.toUpperCase().replaceAll("-", "_")}_ARCHIVE_RPC`;
  const archiveRpcUrl = env[archiveRpcEnvVar];
  const deployment: DeploymentRecord = loadDeployment(chainName);
  return new OnChainSettlementReader({
    chainName,
    rpcUrl,
    ...(archiveRpcUrl ? { archiveRpcUrl } : {}),
    escrowAddress: deployment.contracts.TouchstoneEscrow.address,
  });
}
