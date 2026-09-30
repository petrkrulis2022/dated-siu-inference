import type { Hex } from "viem";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { advanceTime } from "../devnet/anvil.js";
import { signDryLoopRateAttestation } from "./context.js";

export interface ExternalCapacityReturnsResult {
  headroomBefore: bigint;
  headroomDuringRun: bigint;
  headroomAfterRunEnd: bigint;
  quantity: bigint;
  settleBeforeRunEndError: string;
}

const RUN_SECONDS = 1200;

/**
 * The claim the F1 protocol rests on: **capacity the external buyer consumes is returned at the
 * end of the run, exactly.**
 *
 * The external buyer takes 6,000 mSIU a run. Until 2026-09-30 its claim carried a window ending
 * far past the run — `now + windowSeconds * WINDOW_COUNT * 4` — so it could never be settled and
 * that headroom was gone permanently. Five runs of it left ISSUER-A holding 2,000 mSIU of a
 * 48,000 limit, below every job size in the experiment, and run 10 was consequently a
 * one-issuer market whose asset-choice figures measure a buyer with no alternative supplier.
 * Runs meant to be compared were each starting from a poorer market than the last.
 *
 * Two properties are asserted here, and the second is the one that makes the first safe:
 *
 * 1. The capacity comes back, to the unit, so consecutive runs start from identical headroom.
 * 2. It does NOT come back early. Scarcity within a run is exactly what it was — a claim whose
 *    window has not closed cannot be settled at all, so nothing about window 3 gets easier.
 */
export async function runExternalCapacityReturns(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "external-capacity-returns",
): Promise<ExternalCapacityReturnsResult> {
  const buyer = runners.ORCHESTRATOR;
  const issuerA = devnet.agents["ISSUER-A"];
  const quantity = 3_000n;

  const readHeadroom = async (turn: number): Promise<bigint> => {
    const record = await buyer.callTool(
      "check_headroom",
      { issuer: issuerA.address, classId: CLASS_CODE },
      { turn, jobId },
    );
    return BigInt((record.result as { totalHeadroom: string }).totalHeadroom);
  };

  const headroomBefore = await readHeadroom(1);

  // The fix, expressed as the claim's own bounds: a window that ends WITH the run rather than
  // far beyond it.
  const now = Math.floor(Date.now() / 1000);
  const runEndsAt = now + RUN_SECONDS;
  const rateAttestation = await signDryLoopRateAttestation(devnet, runEndsAt);
  const mintRecord = await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_CODE,
      quantity: quantity.toString(),
      windowFrom: now - 60,
      windowTo: runEndsAt,
      ...rateAttestation,
    },
    { turn: 2, jobId },
  );
  const minted = mintRecord.result as { tokenId: string; issuer: Hex };

  const headroomDuringRun = await readHeadroom(3);

  // Not settleable before the run ends — scarcity within the run is untouched by this fix.
  let settleBeforeRunEndError = "";
  try {
    await buyer.callTool(
      "settle_window_close",
      { tokenId: minted.tokenId, holder: devnet.agents.ORCHESTRATOR.address, ...rateAttestation },
      { turn: 4, jobId },
    );
  } catch (err) {
    settleBeforeRunEndError = err instanceof Error ? err.message : String(err);
  }
  if (settleBeforeRunEndError === "") {
    throw new Error(
      "runExternalCapacityReturns: capacity was returned before the run ended — the fix is " +
        "topping the pool up mid-run, which destroys the scarcity the run exists to produce.",
    );
  }

  // The run ends. Never presented, so this Expires: headroom back, nothing paid, no bond drawn.
  await advanceTime(devnet.rpcUrl, RUN_SECONDS + 60);
  await buyer.callTool(
    "settle_window_close",
    { tokenId: minted.tokenId, holder: devnet.agents.ORCHESTRATOR.address, ...rateAttestation },
    { turn: 5, jobId },
  );

  return {
    headroomBefore,
    headroomDuringRun,
    headroomAfterRunEnd: await readHeadroom(6),
    quantity,
    settleBeforeRunEndError,
  };
}
