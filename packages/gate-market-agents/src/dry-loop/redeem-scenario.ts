import { keccak256, stringToBytes } from "viem";
import type { GateSpec, G1ToG5Result } from "@touchstone/gate-market";
import {
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_GATE_1_TRIVIAL,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
} from "@touchstone/gate-market";
import { minorUnitsToUsd } from "@touchstone/sdk";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { buildReceipt } from "../receipt/emit.js";
import type { GateMarketReceipt } from "../receipt/types.js";
import { DRY_LOOP_MICRO_USD_PER_SIU } from "./context.js";

export interface RedeemScenarioParams {
  devnet: DevnetHandle;
  runners: Record<AgentId, Runner>;
  buyerAgentId: AgentId;
  holderAgentId: AgentId;
  /** The candidate gate the holder "submits" for grading — the only thing that varies between
   * the happy path and the failing-submission scenario. Everything else (the reference task, the
   * known-good and adversarial test vectors) is fixed, matching `code.test.ts`'s own proven
   * combination. */
  candidateHardenedGate: GateSpec;
  jobId: string;
  parentPaymentId: string | null;
  quantity?: bigint;
}

export interface RedeemScenarioResult {
  tokenId: string;
  issuerAgentId: AgentId;
  headroomBeforeMint: bigint;
  headroomAfterMint: bigint;
  headroomAfterServe: bigint;
  holderBalanceAfterServe: bigint;
  gateResult: G1ToG5Result;
  receipt: GateMarketReceipt;
}

function issuerAgentIdFor(devnet: DevnetHandle, issuerAddress: string): AgentId {
  const entry = Object.values(devnet.agents).find(
    (agent) => agent.address.toLowerCase() === issuerAddress.toLowerCase(),
  );
  if (!entry) throw new Error(`No provisioned agent matches routed issuer ${issuerAddress}.`);
  return entry.agentId;
}

/**
 * The core of spec §4.4's REDEEM operation, scripted end to end with real chain writes and real
 * sandboxed grading, no model: mint -> transfer -> present_for_redemption -> submit_job (real
 * G1-G5) -> serve_redemption -> a real `GateMarketReceipt`. Shared by `happy-path.ts` (candidate
 * passes) and `failing-submission.ts` (candidate genuinely fails) — the only difference between
 * them is which gate is submitted as the candidate.
 */
export async function runRedeemScenario(
  params: RedeemScenarioParams,
): Promise<RedeemScenarioResult> {
  const { devnet, runners, buyerAgentId, holderAgentId, candidateHardenedGate, jobId } = params;
  const quantity = params.quantity ?? 10n;
  const buyer = runners[buyerAgentId];
  const holder = runners[holderAgentId];

  const now = Math.floor(Date.now() / 1000);
  const windowFrom = now - 60;
  const windowTo = now + 3600;

  // ClaimRouter.route picks the first registered issuer with sufficient headroom — ISSUER-A was
  // provisioned first (identity/resolve.ts's AGENT_IDS order) and, for any quantity this small,
  // always has enough — so which issuer will be routed is knowable *before* minting, letting
  // this read a genuine before/after headroom pair rather than deriving "before" algebraically
  // from "after" (which would just restate the contract's own arithmetic, not check it).
  const expectedIssuer = devnet.agents["ISSUER-A"];
  const headroomBeforeMintRecord = await buyer.callTool(
    "check_headroom",
    { issuer: expectedIssuer.address, classId: CLASS_CODE },
    { turn: 0, jobId },
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
    { turn: 1, jobId },
  );
  const mintResult = mintRecord.result as { tokenId: string; issuer: string; txHash: string };
  const issuerAgentId = issuerAgentIdFor(devnet, mintResult.issuer);
  const issuer = runners[issuerAgentId];
  if (mintResult.issuer.toLowerCase() !== expectedIssuer.address.toLowerCase()) {
    throw new Error(
      `runRedeemScenario: expected ClaimRouter to route to ISSUER-A (${expectedIssuer.address}), ` +
        `got ${mintResult.issuer} — the headroom-before/after comparison below assumes this.`,
    );
  }

  const headroomAfterMintRecord = await buyer.callTool(
    "check_headroom",
    { issuer: mintResult.issuer, classId: CLASS_CODE },
    { turn: 1, jobId },
  );
  const headroomAfterMint = BigInt(
    (headroomAfterMintRecord.result as { headroom: string }).headroom,
  );

  await buyer.callTool(
    "transfer_claim",
    { to: holder.address, tokenId: mintResult.tokenId, quantity: quantity.toString() },
    { turn: 2, jobId },
  );

  const taskSpecHash = keccak256(stringToBytes(`gate-hardening:${jobId}`));
  await holder.callTool(
    "redeem_claim",
    { tokenId: mintResult.tokenId, taskSpecHash },
    { turn: 3, jobId },
  );

  const gateResultRecord = await holder.callTool(
    "submit_job",
    {
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      hardenedGate: candidateHardenedGate,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
    },
    { turn: 4, jobId },
  );
  const gateResult = gateResultRecord.result as G1ToG5Result;

  const receiptRef = keccak256(stringToBytes(`receipt:${jobId}`));
  await issuer.callTool(
    "serve_redemption",
    {
      tokenId: mintResult.tokenId,
      holder: holder.address,
      quantity: quantity.toString(),
      passed: gateResult.passed,
      receiptRef,
    },
    { turn: 5, jobId },
  );

  const headroomAfterServeRecord = await buyer.callTool(
    "check_headroom",
    { issuer: mintResult.issuer, classId: CLASS_CODE },
    { turn: 6, jobId },
  );
  const headroomAfterServe = BigInt(
    (headroomAfterServeRecord.result as { headroom: string }).headroom,
  );

  const balancesRecord = await holder.callTool(
    "get_balances",
    { account: holder.address, tokenIds: [mintResult.tokenId] },
    { turn: 6, jobId },
  );
  const holderBalanceAfterServe = BigInt(
    (balancesRecord.result as { claims: Array<{ tokenId: string; balance: string }> }).claims[0]
      .balance,
  );

  const settlementAmountMicroUsd = (quantity * DRY_LOOP_MICRO_USD_PER_SIU) / 1000n;
  const receipt = buildReceipt({
    receiptId: `receipt:${jobId}`,
    parentPaymentId: params.parentPaymentId,
    quoteId: `quote:${jobId}`,
    buyer: buyerAgentId,
    seller: issuerAgentId,
    executor: holderAgentId,
    taskClass: "code",
    siuDelivered: Number(quantity) / 1000,
    gateResult,
    settlementAsset: `fsiu:code/${jobId}`,
    settlementAmount: Number(quantity),
    usdcEquivalentAtPrint: minorUnitsToUsd(settlementAmountMicroUsd.toString()),
    printId: "dry-loop-illustrative",
    methodologyVersion: "SIU-2026a",
    gateSpecHash: keccak256(stringToBytes(candidateHardenedGate.source)),
    adversarialCaseHashes: [],
  });

  return {
    tokenId: mintResult.tokenId,
    issuerAgentId,
    headroomBeforeMint,
    headroomAfterMint,
    headroomAfterServe,
    holderBalanceAfterServe,
    gateResult,
    receipt,
  };
}
