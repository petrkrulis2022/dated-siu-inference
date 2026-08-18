import { resolve } from "node:path";
import { loadDeployment } from "@touchstone/sdk";

/** pnpm always runs package scripts (and this repo's `dev.mjs`/`tsx` invocations) with cwd =
 * the package directory. */
function repoRoot(): string {
  return resolve(process.cwd(), "../..");
}

/**
 * Every value here is either read from `.env` (already sourced into the shell before this
 * process starts — same convention every other script in this repo uses; no `dotenv` dependency)
 * or from `data/deployments/<chain>.json` via `loadDeployment` (never hardcoded). No key material
 * is ever read: `TOUCHSTONE_PUBLISHER_KEY`/`DEPLOYER_PRIVATE_KEY` are never touched by this package.
 */
export interface ConsoleConfig {
  port: number;
  host: "127.0.0.1";
  chainName: string;
  chainId: number;
  rpcUrl: string;
  explorerBaseUrl: string;
  escrowAddress: string;
  escrowDeployBlock: bigint;
  attestationAddress: string;
  attestationDeployBlock: bigint;
  publisherAddress: string | null;
  printsDir: string;
  runsDirRoot: string;
  registryDir: string;
  eventCachePath: string;
  localQuotesDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set — source .env before starting the console.`);
  }
  return value;
}

export function loadConfig(): ConsoleConfig {
  const chainName = process.env.TOUCHSTONE_CHAIN_NAME ?? "base-sepolia";
  const rpcEnvVar = `${chainName.toUpperCase().replaceAll("-", "_")}_RPC_URL`;
  const rpcUrl = requireEnv(rpcEnvVar);

  const deployment = loadDeployment(chainName);
  const escrowBlock = (deployment.contracts.TouchstoneEscrow as { blockNumber?: number })
    .blockNumber;
  const attestationBlock = (deployment.contracts.TouchstoneAttestation as { blockNumber?: number })
    .blockNumber;
  if (escrowBlock === undefined || attestationBlock === undefined) {
    throw new Error(
      `data/deployments/${chainName}.json is missing a contract blockNumber — cannot bound the ` +
        `indexer's scan.`,
    );
  }

  return {
    port: Number(process.env.CONSOLE_PORT ?? 5274),
    host: "127.0.0.1",
    chainName,
    chainId: deployment.network.chainId,
    rpcUrl,
    explorerBaseUrl: deployment.network.explorer,
    escrowAddress: deployment.contracts.TouchstoneEscrow.address,
    escrowDeployBlock: BigInt(escrowBlock),
    attestationAddress: deployment.contracts.TouchstoneAttestation.address,
    attestationDeployBlock: BigInt(attestationBlock),
    publisherAddress: process.env.TOUCHSTONE_PUBLISHER_ADDRESS ?? null,
    printsDir: resolve(repoRoot(), "data/prints"),
    runsDirRoot: resolve(repoRoot(), "data/runs"),
    registryDir: resolve(repoRoot(), "data/registry"),
    eventCachePath: resolve(repoRoot(), "data/.cache/console/events.json"),
    localQuotesDir: resolve(repoRoot(), "data/.cache/quotes"),
  };
}
