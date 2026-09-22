import { keccak256, stringToBytes, type Hex } from "viem";
import { minorUnitsToUsd } from "@touchstone/sdk";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { advanceTime } from "../devnet/anvil.js";
import { DRY_LOOP_MICRO_USD_PER_SIU } from "./context.js";

export interface DefaultAndRerouteResult {
  holderBalanceAfterSettle: bigint;
  headroomAfterSettle: bigint;
  headroomBeforeMint: bigint;
  holderUsdcDelta: string;
  expectedDefaultPayoutUsd: string;
  secondMintSucceeded: boolean;
}

/**
 * Spec §4.5's third forced state — DEFAULT — reconciled against what `WorkClaim.sol` actually
 * implements (this package's WP-5 plan explains why): a claim's issuer is fixed at mint time,
 * and there is no path that moves an *existing* claim to a different issuer, so "re-routing"
 * cannot mean rescuing this specific claim. What it tests instead: the window closes with the
 * claim presented but never served (simulating the issuer's harness path being down); settling
 * it produces the Defaulted terminal state (bond pays the holder, headroom restored); and,
 * because headroom is genuinely restored (not stuck), a *later* mint in the same class succeeds
 * again — the system recovers rather than wedging.
 */
export async function runDefaultAndReroute(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "default-and-reroute",
): Promise<DefaultAndRerouteResult> {
  const buyer = runners.ORCHESTRATOR;
  const holder = runners["WORKER-CODE"];
  const issuerA = devnet.agents["ISSUER-A"];
  const quantity = 10n;

  const now = Math.floor(Date.now() / 1000);
  const windowFrom = now - 60;
  // Wide enough to survive real transaction latency — mint, transfer, and present are all real
  // on-chain txs before this window needs to still be open, and each one's own round-trip can
  // take several real seconds in a loaded CI environment (confirmed live: an earlier 5-second
  // window closed for real before present_for_redemption even ran, reverting with WindowClosed —
  // not a bug in the contract, a bug in this fixture conflating "wall-clock time to confirm three
  // txs" with "the simulated window duration"). The devnet's own clock, not wall time, is what
  // actually closes the window — see the explicit advanceTime call below.
  const windowTo = now + 600;

  const headroomBeforeMintRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 1, jobId },
  );
  const headroomBeforeMint = BigInt(
    (headroomBeforeMintRecord.result as { headroom: string }).headroom,
  );

  const mintRecord = await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_CODE,
      quantity: quantity.toString(),
      windowFrom,
      windowTo,
      microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
    },
    { turn: 2, jobId },
  );
  const mintResult = mintRecord.result as { tokenId: string; issuer: Hex };
  if (mintResult.issuer.toLowerCase() !== issuerA.address.toLowerCase()) {
    throw new Error(
      `runDefaultAndReroute: expected the mint to route to ISSUER-A, got ${mintResult.issuer}.`,
    );
  }

  await buyer.callTool(
    "transfer_claim",
    { to: holder.address, tokenId: mintResult.tokenId, quantity: quantity.toString() },
    { turn: 3, jobId },
  );

  const taskSpecHash = keccak256(stringToBytes(`gate-hardening:${jobId}`));
  await holder.callTool(
    "redeem_claim",
    { tokenId: mintResult.tokenId, taskSpecHash },
    { turn: 4, jobId },
  );

  // ISSUER-A's harness path is "down" for this window — nobody ever calls serve_redemption.
  // Advance the devnet's own clock well past windowTo (600s from mint), then settle — 700s
  // clears it regardless of how much real wall-clock time the preceding txs themselves took.
  await advanceTime(devnet.rpcUrl, 700);

  const holderUsdcBeforeRecord = await holder.callTool(
    "get_balances",
    { account: holder.address },
    { turn: 5, jobId },
  );
  const holderUsdcBefore = BigInt(
    (holderUsdcBeforeRecord.result as { usdc: { integerMinorUnits: string } }).usdc
      .integerMinorUnits,
  );

  await buyer.callTool(
    "settle_window_close",
    {
      tokenId: mintResult.tokenId,
      holder: holder.address,
      microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
    },
    { turn: 6, jobId },
  );

  const holderUsdcAfterRecord = await holder.callTool(
    "get_balances",
    { account: holder.address },
    { turn: 7, jobId },
  );
  const holderUsdcAfter = BigInt(
    (holderUsdcAfterRecord.result as { usdc: { integerMinorUnits: string } }).usdc
      .integerMinorUnits,
  );

  const balancesRecord = await holder.callTool(
    "get_balances",
    { account: holder.address, tokenIds: [mintResult.tokenId] },
    { turn: 8, jobId },
  );
  const holderBalanceAfterSettle = BigInt(
    (balancesRecord.result as { claims: Array<{ tokenId: string; balance: string }> }).claims[0]
      .balance,
  );

  const headroomAfterSettleRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 9, jobId },
  );
  const headroomAfterSettle = BigInt(
    (headroomAfterSettleRecord.result as { headroom: string }).headroom,
  );

  // A later mint, same class — headroom is genuinely available again, so this must succeed.
  let secondMintSucceeded = true;
  try {
    await buyer.callTool(
      "mint_claim",
      {
        classId: CLASS_CODE,
        quantity: "5",
        windowFrom: Math.floor(Date.now() / 1000) - 60,
        windowTo: Math.floor(Date.now() / 1000) + 3600,
        microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
      },
      { turn: 10, jobId },
    );
  } catch {
    secondMintSucceeded = false;
  }

  const expectedDefaultPayoutMicroUsd = (quantity * DRY_LOOP_MICRO_USD_PER_SIU) / 1000n;

  return {
    holderBalanceAfterSettle,
    headroomAfterSettle,
    headroomBeforeMint,
    holderUsdcDelta: minorUnitsToUsd((holderUsdcAfter - holderUsdcBefore).toString()),
    expectedDefaultPayoutUsd: minorUnitsToUsd(expectedDefaultPayoutMicroUsd.toString()),
    secondMintSucceeded,
  };
}
