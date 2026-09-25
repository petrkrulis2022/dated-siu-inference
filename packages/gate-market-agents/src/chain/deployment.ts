import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export interface GateMarketDeployment {
  network: { name: string; chainId: number };
  usdc: { address: string };
  capacityBond: { address: string };
  claimRouter: { address: string };
  workClaim: { address: string };
}

function repoRoot(): string {
  // packages/gate-market-agents/src/chain/deployment.ts -> repo root is four levels up.
  return path.resolve(fileURLToPath(import.meta.url), "../../../../..");
}

/**
 * `CapacityBond`/`ClaimRouter`/`WorkClaim` are deployed to Base Sepolia as of 2026-09-25 (WP-7) —
 * `data/deployments/base-sepolia-gate-market.json` records the real addresses, verified on
 * Basescan, plus both issuers' real bonded capacity lots. This still throws with an actionable
 * message rather than returning placeholder addresses whenever that file is absent (a fresh
 * checkout that hasn't run the deploy script, or a caller pointed at a different, not-yet-
 * deployed chain's file) — matching `StubSettlementReader`'s and `Erc8004Resolver`'s precedent of
 * failing loudly instead of fabricating a plausible-looking value.
 */
export function loadGateMarketDeployment(
  file = "data/deployments/base-sepolia-gate-market.json",
): GateMarketDeployment {
  const fullPath = path.join(repoRoot(), file);
  let raw: string;
  try {
    raw = readFileSync(fullPath, "utf-8");
  } catch {
    throw new Error(
      `${file} does not exist — CapacityBond/ClaimRouter/WorkClaim have not been deployed to ` +
        "Base Sepolia yet. Run packages/contracts/script/DeployGateMarket.s.sol, record the " +
        "resulting addresses at this path (see data/deployments/base-sepolia.json for the " +
        "shape this repo already uses for TouchstoneAttestation/TouchstoneEscrow), then retry.",
    );
  }
  return JSON.parse(raw) as GateMarketDeployment;
}
