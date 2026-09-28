import type { Hex } from "viem";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { advanceTime } from "../devnet/anvil.js";
import { signDryLoopRateAttestation } from "./context.js";

export interface ForwardDatedClaimResult {
  tokenId: string;
  issuer: Hex;
  headroomBeforeMint: bigint;
  headroomAfterMint: bigint;
  headroomAfterDelivery: bigint;
  presentBeforeWindowOpenedError: string;
  presentedOnceWindowOpened: boolean;
}

/** Three 20-minute windows, the same shape the real three-window run uses. */
const WINDOW_SECONDS = 1200;

/**
 * The property the whole three-window design rests on: **a claim minted while standing in window 1
 * for delivery in window 3 consumes that issuer's capacity immediately, cannot be presented until
 * window 3 opens, and redeems normally once it does.**
 *
 * Until 2026-09-28 the loop always minted against the *current* window's bounds, so this was not
 * merely untested — it was impossible. That mattered more than it looks: fSIU's entire claimed
 * property is that it reserves capacity for a future delivery window, and without it a claim is
 * only a slower way to pay for work about to be consumed. An all-USDC run would then have read as
 * a preference finding when the alternative it was compared against never existed.
 *
 * Scripted, on a real devnet whose clock can be warped — the same reason `default-and-reroute.ts`
 * warps rather than waits. The real run waits on a real chain instead.
 */
export async function runForwardDatedClaim(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "forward-dated-claim",
): Promise<ForwardDatedClaimResult> {
  const buyer = runners.ORCHESTRATOR;
  const issuerA = devnet.agents["ISSUER-A"];

  const readHeadroom = async (turn: number): Promise<bigint> => {
    const record = await buyer.callTool(
      "check_headroom",
      { issuer: issuerA.address, classId: CLASS_CODE },
      { turn, jobId },
    );
    return BigInt((record.result as { totalHeadroom: string }).totalHeadroom);
  };

  const now = Math.floor(Date.now() / 1000);
  // Window 1 is open now; window 3 opens two spans from now — exactly the arithmetic the real
  // runner does from the chain clock before its first turn.
  const window3From = now + 2 * WINDOW_SECONDS;
  const window3To = now + 3 * WINDOW_SECONDS;

  const headroomBeforeMint = await readHeadroom(1);
  const rateAttestation = await signDryLoopRateAttestation(devnet, window3To);

  // Minted while standing in window 1, dated for window 3.
  const mintRecord = await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_CODE,
      quantity: "500",
      windowFrom: window3From,
      windowTo: window3To,
      ...rateAttestation,
    },
    { turn: 2, jobId },
  );
  const minted = mintRecord.result as { tokenId: string; issuer: Hex };

  // Capacity is gone NOW, not when window 3 arrives — that is what "reserves future capacity"
  // has to mean for it to be worth anything.
  const headroomAfterMint = await readHeadroom(3);

  // And it cannot be used yet.
  let presentBeforeWindowOpenedError = "";
  try {
    await buyer.callTool(
      "redeem_claim",
      { tokenId: minted.tokenId, taskSpecHash: `0x${"33".repeat(32)}` },
      { turn: 4, jobId },
    );
  } catch (err) {
    presentBeforeWindowOpenedError = err instanceof Error ? err.message : String(err);
  }
  if (presentBeforeWindowOpenedError === "") {
    throw new Error(
      "runForwardDatedClaim: a window-3 claim was presentable during window 1 — the window guard is not holding.",
    );
  }

  // Window 3 opens.
  await advanceTime(devnet.rpcUrl, 2 * WINDOW_SECONDS + 60);

  await buyer.callTool(
    "redeem_claim",
    { tokenId: minted.tokenId, taskSpecHash: `0x${"33".repeat(32)}` },
    { turn: 5, jobId },
  );

  // The routed issuer delivers, which retires the claim and returns the capacity.
  await runners["ISSUER-A"].callTool(
    "serve_redemption",
    {
      tokenId: minted.tokenId,
      holder: devnet.agents.ORCHESTRATOR.address,
      quantity: "500",
      passed: true,
      receiptRef: `0x${"44".repeat(32)}`,
    },
    { turn: 6, jobId },
  );

  return {
    tokenId: minted.tokenId,
    issuer: minted.issuer,
    headroomBeforeMint,
    headroomAfterMint,
    headroomAfterDelivery: await readHeadroom(7),
    presentBeforeWindowOpenedError,
    presentedOnceWindowOpened: true,
  };
}
