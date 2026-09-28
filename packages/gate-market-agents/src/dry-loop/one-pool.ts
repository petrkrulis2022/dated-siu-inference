import type { Hex } from "viem";
import { buildQuoteBody, signQuote } from "@touchstone/sdk";
import type { Runner } from "../runner.js";
import { erc8004IdFor, type AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { DRY_LOOP_NANO_USD_PER_SIU } from "./context.js";

export interface OnePoolResult {
  headroomBefore: bigint;
  headroomAfterReserve: bigint;
  headroomAfterSettle: bigint;
  reservedQuantity: bigint;
  routedIssuer: Hex;
}

/** The job's size in SIU. 0.020 SIU = 20 mSIU — small enough to leave the pool intact for any
 * scenario sharing the devnet, large enough that the headroom move is unambiguous. */
const JOB_SIU = "0.020";
const EXPECTED_MILLI_SIU = 20n;

/**
 * The one-pool property, end to end on real bytecode: **a job paid for in dollars consumes the
 * same bonded capacity a minted claim does.**
 *
 * This is the scenario the first real P5 window needed and did not have. There, an orchestrator
 * paid in USDC and ISSUER-A's headroom did not move at all — so the run's "which asset did the
 * agent choose" question was really asking "did the agent accept a constraint that applied to
 * only one of the two options". `WorkClaim.reserveForWork` closed that, and this proves the whole
 * TypeScript path to it (quote -> pay -> reserve_for_work -> settle_escrow) against a real chain
 * rather than only the Solidity in Foundry.
 *
 * Scripted, not model-driven, like every other dry-loop scenario: no agent decides anything here.
 */
export async function runOnePool(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "one-pool",
): Promise<OnePoolResult> {
  const buyer = runners.ORCHESTRATOR;
  const seller = runners["WORKER-CODE"];
  const sellerAddress = devnet.agents["WORKER-CODE"].address;
  const issuerA = devnet.agents["ISSUER-A"];

  const headroomBefore = await readHeadroom(buyer, issuerA.address, jobId, 1);
  if (headroomBefore < EXPECTED_MILLI_SIU) {
    throw new Error(`runOnePool requires ISSUER-A to start with at least ${EXPECTED_MILLI_SIU} mSIU.`);
  }

  // A real seller-signed quote, built and signed exactly as `request_quote`/`issue_quote` do —
  // the quote hash is what ties escrow and reservation together, so it must be the genuine
  // article rather than a fixture hash.
  const quoteBody = buildQuoteBody({
    siu: JOB_SIU,
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
  // The quote must name the asset this devnet actually settles in; `buildQuoteBody` resolves the
  // chain's canonical USDC, which on an ephemeral local chain is a freshly-deployed MockUSDC.
  const quote = await signQuote(
    {
      ...quoteBody,
      settlement: [{ ...quoteBody.settlement[0], address: devnet.deployment.usdc.address }],
    },
    devnet.agents["WORKER-CODE"].privateKeyHex,
  );

  await buyer.callTool(
    "pay",
    { quote, settler: "0x0000000000000000000000000000000000000000" },
    { turn: 2, jobId },
  );

  // Paying alone must not move capacity — only the seller's own commitment does. Asserted rather
  // than assumed, because "the dollar route consumes nothing" was exactly the defect being fixed
  // and its opposite (capacity consumed twice) would be just as wrong.
  const headroomAfterPay = await readHeadroom(buyer, issuerA.address, jobId, 3);
  if (headroomAfterPay !== headroomBefore) {
    throw new Error(
      `runOnePool: opening escrow moved headroom on its own (${headroomBefore} -> ${headroomAfterPay}).`,
    );
  }

  const reserveRecord = await seller.callTool(
    "reserve_for_work",
    { quote, classId: CLASS_CODE },
    { turn: 4, jobId },
  );
  const reserved = reserveRecord.result as { issuer: Hex; quantity: string };

  const headroomAfterReserve = await readHeadroom(buyer, issuerA.address, jobId, 5);

  await seller.callTool(
    "settle_escrow",
    { quote, receiptRef: `0x${"22".repeat(32)}` },
    { turn: 6, jobId },
  );

  const headroomAfterSettle = await readHeadroom(buyer, issuerA.address, jobId, 7);

  return {
    headroomBefore,
    headroomAfterReserve,
    headroomAfterSettle,
    reservedQuantity: BigInt(reserved.quantity),
    routedIssuer: reserved.issuer,
  };
}

async function readHeadroom(
  runner: Runner,
  issuer: Hex,
  jobId: string,
  turn: number,
): Promise<bigint> {
  const record = await runner.callTool(
    "check_headroom",
    { issuer, classId: CLASS_CODE },
    { turn, jobId },
  );
  return BigInt((record.result as { totalHeadroom: string }).totalHeadroom);
}

/** Exported so the test can state the rate the fixture quote was priced at without restating it. */
export const ONE_POOL_NANO_USD_PER_SIU = DRY_LOOP_NANO_USD_PER_SIU;
export const ONE_POOL_EXPECTED_MILLI_SIU = EXPECTED_MILLI_SIU;
