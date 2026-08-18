import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface DeploymentContract {
  address: string;
  explorerUrl: string;
  [key: string]: unknown;
}

export interface DeploymentRecord {
  network: { name: string; chainId: number; explorer: string };
  contracts: {
    TouchstoneAttestation: DeploymentContract;
    TouchstoneEscrow: DeploymentContract;
  };
  usdc: { address: string; decimals: number; source: string };
  [key: string]: unknown;
}

/**
 * Reads `data/deployments/<network>.json` — the canonical record of a live contract deployment
 * (P13). `packages/print` (anchoring) and `packages/mcp-server` (SettlementReader) both read
 * from this one file rather than hardcoding addresses, so a redeploy or a new network is a data
 * change, never a code change, and the two packages can never quietly disagree about where the
 * contracts live.
 *
 * `dir` defaults to `data/deployments` resolved the same way every CLI in this repo resolves
 * `data/` — relative to `process.cwd()` under pnpm's "scripts run with cwd = the package
 * directory" convention. Pass an explicit `dir` when calling from somewhere that doesn't hold.
 */
export function loadDeployment(network: string, dir?: string): DeploymentRecord {
  const deploymentsDir = dir ?? resolve(process.cwd(), "../../data/deployments");
  const path = resolve(deploymentsDir, `${network}.json`);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Could not read deployment record at ${path}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const record = raw as Partial<DeploymentRecord>;
  if (
    !record.network?.chainId ||
    !record.contracts?.TouchstoneAttestation?.address ||
    !record.contracts?.TouchstoneEscrow?.address ||
    !record.usdc?.address
  ) {
    throw new Error(
      `Malformed deployment record at ${path}: missing network.chainId, ` +
        `contracts.TouchstoneAttestation.address, contracts.TouchstoneEscrow.address, or usdc.address.`,
    );
  }

  return record as DeploymentRecord;
}
