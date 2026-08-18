import { loadDeployment, type DeploymentRecord } from "@touchstone/sdk";
import { OnChainSettlementReader } from "./settlement/on-chain.js";
import type { SettlementReader } from "./settlement/reader.js";

/**
 * A minimal, local copy of packages/print/src/sign/sign.ts's env-key convention — reading
 * `TOUCHSTONE_PUBLISHER_KEY` directly rather than importing @touchstone/print for one helper function,
 * which would pull @touchstone/basket and @touchstone/harness in as transitive workspace deps for no
 * other reason.
 */
export const PUBLISHER_KEY_ENV = "TOUCHSTONE_PUBLISHER_KEY";
export const SELLER_ADDRESS_ENV = "TOUCHSTONE_SELLER_ADDRESS";
export const CHAIN_NAME_ENV = "TOUCHSTONE_CHAIN_NAME";

export function loadPublisherKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[PUBLISHER_KEY_ENV];
  if (!key) {
    throw new Error(
      `${PUBLISHER_KEY_ENV} is not set. verify_receipt signs with the same publisher key ` +
        `prints are signed with; it is never committed and never defaulted.`,
    );
  }
  return key;
}

/** The EVM wallet address Circle's Gateway middleware pays out to — build1-spec.md §9. */
export function loadSellerAddressFromEnv(env: NodeJS.ProcessEnv = process.env): string {
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
  env: NodeJS.ProcessEnv = process.env,
): SettlementReader {
  const chainName = env[CHAIN_NAME_ENV] ?? "base-sepolia";
  const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  const rpcUrl = env[rpcEnvVar];
  if (!rpcUrl) {
    throw new Error(
      `${rpcEnvVar} is not set — cannot read on-chain settlements for chain "${chainName}".`,
    );
  }
  const deployment: DeploymentRecord = loadDeployment(chainName);
  return new OnChainSettlementReader({
    chainName,
    rpcUrl,
    escrowAddress: deployment.contracts.TouchstoneEscrow.address,
  });
}
