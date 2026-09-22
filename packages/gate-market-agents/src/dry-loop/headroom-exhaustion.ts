import type { Hex } from "viem";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { DRY_LOOP_MICRO_USD_PER_SIU } from "./context.js";

export interface HeadroomExhaustionResult {
  issuerAHeadroomBefore: bigint;
  routedIssuerAfterExhaustion: Hex;
}

/**
 * Spec §4.5's first forced state: "Does routing find the other issuer? Does the holder notice?"
 * `ClaimRouter.route` picks the first registered issuer (ISSUER-A, provisioned first) with
 * sufficient headroom — not a round-robin or size-based rule — so the real way to force a mint
 * onto ISSUER-B is to fully exhaust ISSUER-A first, in one mint sized to its exact current
 * headroom, then mint again and confirm the router moves on to ISSUER-B.
 */
export async function runHeadroomExhaustion(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "headroom-exhaustion",
): Promise<HeadroomExhaustionResult> {
  const buyer = runners.ORCHESTRATOR;
  const issuerA = devnet.agents["ISSUER-A"];
  const issuerB = devnet.agents["ISSUER-B"];

  const now = Math.floor(Date.now() / 1000);
  const windowFrom = now - 60;
  const windowTo = now + 3600;

  const headroomRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 1, jobId },
  );
  const issuerAHeadroomBefore = BigInt((headroomRecord.result as { headroom: string }).headroom);
  if (issuerAHeadroomBefore <= 0n) {
    throw new Error("runHeadroomExhaustion requires ISSUER-A to start with real headroom.");
  }

  // One mint sized to exactly ISSUER-A's current headroom — fully exhausts it in a single call
  // rather than looping thousands of small mints.
  await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_CODE,
      quantity: issuerAHeadroomBefore.toString(),
      windowFrom,
      windowTo,
      microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
    },
    { turn: 2, jobId },
  );

  const headroomAfterExhaustionRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 3, jobId },
  );
  const issuerAHeadroomAfter = BigInt(
    (headroomAfterExhaustionRecord.result as { headroom: string }).headroom,
  );
  if (issuerAHeadroomAfter !== 0n) {
    throw new Error(
      `runHeadroomExhaustion: expected ISSUER-A's headroom to reach exactly 0, got ${issuerAHeadroomAfter}.`,
    );
  }

  // The next mint of any size must skip the now-exhausted ISSUER-A and route to ISSUER-B.
  const secondMintRecord = await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_CODE,
      quantity: "10",
      windowFrom,
      windowTo,
      microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
    },
    { turn: 4, jobId },
  );
  const secondMintResult = secondMintRecord.result as { issuer: Hex };

  if (secondMintResult.issuer.toLowerCase() !== issuerB.address.toLowerCase()) {
    throw new Error(
      `runHeadroomExhaustion: expected the second mint to route to ISSUER-B (${issuerB.address}), ` +
        `got ${secondMintResult.issuer}.`,
    );
  }

  return {
    issuerAHeadroomBefore,
    routedIssuerAfterExhaustion: secondMintResult.issuer,
  };
}
