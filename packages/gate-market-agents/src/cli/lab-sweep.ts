/**
 * Returns the capacity a lab run left outstanding: `pnpm run lab-sweep`.
 *
 * A run expires every claim it made as its last act. A run that is killed outright — a closed laptop, a
 * crashed process — never gets there, and the next launch refuses to start from a pool that is not whole. The
 * runner writes `<run>-open.json` the moment the endowment exists; this reads every one not yet marked swept,
 * waits until its window has closed, expires each holder's position and checks the pool is back where it began.
 * Expiry is permissionless and unattested for a claim that was never presented, and the lab presents nothing.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadGateMarketDeployment } from "../chain/deployment.js";
import { classIdFor } from "../loop/full-run.js";
import { ISSUER_SEAT } from "../lab/economy.js";
import { viemLabChain } from "../lab/operator-chain.js";
import type { OpenLabState } from "../lab/run.js";
import { REPO_ROOT, toHex } from "./p5-shared.js";

const LAB_RUNS_ROOT = join(REPO_ROOT, "data/lab/runs");
const DEFAULT_DEPLOYMENT = "data/deployments/base-sepolia-gate-market-single-issuer.json";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--deployment");
  const deploymentFile = at === -1 ? DEFAULT_DEPLOYMENT : argv[at + 1];
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  if (rpcUrl === "") throw new Error("BASE_SEPOLIA_RPC_URL is not set.");
  const deployment = loadGateMarketDeployment(deploymentFile);
  const operatorKey = toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  const operator = { label: "operator", address: privateKeyToAccount(operatorKey).address, privateKeyHex: operatorKey };
  // Minting is not used here, so the print and publisher key are placeholders `viemLabChain` never reads.
  const chain = viemLabChain({
    deployment,
    rpcUrl,
    operator,
    publisherKeyHex: operatorKey,
    print: { printId: "unused", series: `0x${"0".repeat(64)}` as Hex, printDate: 0n, nanoUsdPerSiu: 0n },
  });
  const issuerAddress = toHex(process.env.ISSUER_B_ADDRESS, "ISSUER_B_ADDRESS");
  const classId = classIdFor("extract") as Hex;

  const files = readdirSync(LAB_RUNS_ROOT).filter((f) => f.endsWith("-open.json"));
  let outstanding = 0;
  for (const f of files) {
    const path = join(LAB_RUNS_ROOT, f);
    const open = JSON.parse(readFileSync(path, "utf-8")) as OpenLabState & { swept: boolean };
    if (open.swept) continue;
    outstanding++;
    console.log(`${open.runId}: token ${open.tokenId}, window closes at chain time ${open.windowToChainSeconds}.`);
    const closeBy = BigInt(open.windowToChainSeconds);
    for (let now = await chain.now(); now < closeBy; now = await chain.now()) {
      const wait = Number(closeBy - now) + 2;
      console.log(`  waiting ${wait}s for the window to close.`);
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
    for (const h of open.holders) {
      const held = await chain.claimBalance(BigInt(open.tokenId), h.address as Hex);
      if (held === 0n) continue;
      try {
        const tx = await chain.settleExpired(BigInt(open.tokenId), h.address as Hex);
        console.log(`  expired ${held} mSIU held by ${h.label}. tx ${tx}`);
      } catch (err) {
        console.log(`  ${h.label}: ${held} mSIU NOT expired: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
      }
    }
    const headroom = await chain.headroom(issuerAddress, classId);
    const restored = headroom === BigInt(open.startingHeadroomMilliSiu);
    console.log(`  ${ISSUER_SEAT} headroom ${headroom}; started at ${open.startingHeadroomMilliSiu}: ${restored ? "RESTORED" : "NOT restored"}.`);
    if (restored) writeFileSync(path, `${JSON.stringify({ ...open, swept: true }, null, 2)}\n`);
    else process.exitCode = 1;
  }
  if (outstanding === 0) console.log("Nothing outstanding: every run's capacity has been returned.");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
