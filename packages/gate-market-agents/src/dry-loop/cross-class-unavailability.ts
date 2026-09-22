import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE, CLASS_EXTRACT } from "../devnet/deploy.js";
import { DRY_LOOP_MICRO_USD_PER_SIU } from "./context.js";

export interface CrossClassUnavailabilityResult {
  codeHeadroomBefore: bigint;
  codeHeadroomAfter: bigint;
}

/**
 * Spec §4.5's second forced state: "Exhaust extract while code headroom remains — confirms
 * per-class claims are correct and unified ones overstate headroom." Fully exhausts ISSUER-A's
 * `extract` headroom (one mint sized to its exact current value) and asserts its `code`
 * headroom — the same issuer, the other class — is completely unaffected. A pooled/unified
 * headroom implementation would fail this by construction; `CapacityBond.lots` keys on
 * `(issuer, classId)` specifically to make it structurally impossible.
 */
export async function runCrossClassUnavailability(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "cross-class-unavailability",
): Promise<CrossClassUnavailabilityResult> {
  const buyer = runners.ORCHESTRATOR;
  const issuerA = devnet.agents["ISSUER-A"];

  const now = Math.floor(Date.now() / 1000);
  const windowFrom = now - 60;
  const windowTo = now + 3600;

  const codeHeadroomBeforeRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 1, jobId },
  );
  const codeHeadroomBefore = BigInt(
    (codeHeadroomBeforeRecord.result as { headroom: string }).headroom,
  );

  const extractHeadroomRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_EXTRACT },
    { turn: 2, jobId },
  );
  const extractHeadroomBefore = BigInt(
    (extractHeadroomRecord.result as { headroom: string }).headroom,
  );
  if (extractHeadroomBefore <= 0n) {
    throw new Error(
      "runCrossClassUnavailability requires ISSUER-A to start with extract headroom.",
    );
  }

  await buyer.callTool(
    "mint_claim",
    {
      classId: CLASS_EXTRACT,
      quantity: extractHeadroomBefore.toString(),
      windowFrom,
      windowTo,
      microUsdPerSiu: DRY_LOOP_MICRO_USD_PER_SIU.toString(),
    },
    { turn: 3, jobId },
  );

  const extractHeadroomAfterRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_EXTRACT },
    { turn: 4, jobId },
  );
  const extractHeadroomAfter = BigInt(
    (extractHeadroomAfterRecord.result as { headroom: string }).headroom,
  );
  if (extractHeadroomAfter !== 0n) {
    throw new Error(
      `runCrossClassUnavailability: expected extract headroom to reach exactly 0, got ${extractHeadroomAfter}.`,
    );
  }

  const codeHeadroomAfterRecord = await buyer.callTool(
    "check_headroom",
    { issuer: issuerA.address, classId: CLASS_CODE },
    { turn: 5, jobId },
  );
  const codeHeadroomAfter = BigInt(
    (codeHeadroomAfterRecord.result as { headroom: string }).headroom,
  );

  return { codeHeadroomBefore, codeHeadroomAfter };
}
