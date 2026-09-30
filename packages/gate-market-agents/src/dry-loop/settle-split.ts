import type { Hex } from "viem";
import { buildQuoteBody, quoteHashHex, signQuote } from "@touchstone/sdk";
import type { Runner } from "../runner.js";
import { erc8004IdFor, type AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { signDryLoopRateAttestation } from "./context.js";
import { claimValueMinorUnits } from "../tools/settle-split.js";
import { ViemChainReader } from "../chain/reader.js";

export interface SettleSplitScenarioResult {
  quotedMinorUnits: bigint;
  claimQuantityMilliSiu: string;
  claimValueMinorUnits: bigint;
  escrowMaxAmount: bigint;
  sellerClaimBalance: bigint;
  headroomBefore: bigint;
  headroomAfter: bigint;
  claimShare: string;
}

/**
 * **One quote, settled partly in fSIU and partly in USDC, in a single call.**
 *
 * Proves the three things a split has to get right, none of which the unit tests can see:
 * the escrow opens under the ORIGINAL quote's hash (so the seller can still settle what it
 * signed) for the REDUCED amount; the seller really holds the claim leg; and the claim leg
 * really consumed bonded headroom. A split that opened the escrow for the full amount, or under
 * a rewritten hash, would pass every arithmetic test in `tools/settle-split.test.ts`.
 */
export async function runSettleSplit(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "settle-split",
): Promise<SettleSplitScenarioResult> {
  const buyer = runners.ORCHESTRATOR;
  const sellerAddress = devnet.agents["WORKER-CODE"].address as Hex;
  const issuerA = devnet.agents["ISSUER-A"].address as Hex;

  const readHeadroom = async (turn: number): Promise<bigint> => {
    const rec = await buyer.callTool(
      "check_headroom",
      { issuer: issuerA, classId: CLASS_CODE },
      { turn, jobId },
    );
    return BigInt((rec.result as { totalHeadroom: string }).totalHeadroom);
  };

  const quoteBody = buildQuoteBody({
    siu: "0.020",
    model: "dry-loop-fixture",
    rateUsdPerSiu: "0.0100",
    indexVersion: "SIU-2026a",
    printId: "dry-loop-illustrative",
    printHash: `0x${"11".repeat(32)}`,
    sellerId: erc8004IdFor(sellerAddress),
    chain: "base-sepolia",
    expiresInSeconds: 3600,
    pattern: "fixed",
  });
  const quote = await signQuote(
    {
      ...quoteBody,
      settlement: [{ ...quoteBody.settlement[0], address: devnet.deployment.usdc.address }],
    },
    devnet.agents["WORKER-CODE"].privateKeyHex,
  );
  const quotedMinorUnits = BigInt(quote.settlement[0].amount_max);

  const headroomBefore = await readHeadroom(1);
  const now = Math.floor(Date.now() / 1000);
  const windowTo = now + 1200;
  const rateAttestation = await signDryLoopRateAttestation(devnet, windowTo);
  // Deliberately not half: a lopsided split catches an implementation that ignores the stated
  // quantity and settles 50/50, which an even one would not.
  const claimQuantityMilliSiu = "3";

  const result = await buyer.callTool(
    "settle_split",
    {
      quote,
      settler: "0x0000000000000000000000000000000000000000",
      claimQuantityMilliSiu,
      to: sellerAddress,
      classId: CLASS_CODE,
      windowFrom: now - 60,
      windowTo,
      ...rateAttestation,
    },
    { turn: 2, jobId },
  );
  const split = result.result as { claimTokenId: string; claimShare: string };

  const balances = await buyer.callTool(
    "get_balances",
    { account: sellerAddress, tokenIds: [split.claimTokenId] },
    { turn: 3, jobId },
  );
  const claims = (balances.result as { claims: { tokenId: string; balance: string }[] }).claims;

  // Read the escrow directly rather than through a tool: the point is what the CONTRACT holds
  // under the quote's own hash, not what any tool reports about it.
  const escrow = await new ViemChainReader(devnet.deployment, devnet.rpcUrl).escrowState(
    devnet.escrowAddress,
    quoteHashHex(quote) as Hex,
  );

  return {
    quotedMinorUnits,
    claimQuantityMilliSiu,
    claimValueMinorUnits: claimValueMinorUnits(claimQuantityMilliSiu, rateAttestation.nanoUsdPerSiu),
    escrowMaxAmount: escrow.maxAmountMinorUnits,
    sellerClaimBalance: BigInt(claims[0]?.balance ?? "0"),
    headroomBefore,
    headroomAfter: await readHeadroom(4),
    claimShare: split.claimShare,
  };
}
