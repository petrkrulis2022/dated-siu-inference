import type { Hex } from "viem";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { signDryLoopRateAttestation } from "./context.js";

export interface ClaimCirculatesResult {
  tokenId: string;
  issuer: Hex;
  quantity: string;
  firstHolderAfterPayment: bigint;
  firstHolderAfterPassingOn: bigint;
  secondHolderAfterPassingOn: bigint;
  secondHolderAfterRedemption: bigint;
  headroomBefore: bigint;
  headroomAfterDelivery: bigint;
}

/**
 * **A claim passes from one holder to another and is redeemed by the second — without the first
 * ever redeeming it.** Spec §4.4's TRANSFER operation, which has never happened in a real run.
 *
 * Every claim in every run to date was redeemed on the turn after it was received, so fSIU has
 * only ever existed for about thirty seconds and has never passed between parties. That is a
 * settlement rail, not money. It was also not a behavioural finding: WORKER-CODE held neither
 * `transfer_claim` nor `pay_with_claim`, so its only move WAS redeem-then-pay-dollars, and
 * WORKER-EXTRACT held no claim tool at all — it was paid in fSIU twice and could not redeem
 * either claim, both of which expired worthless.
 *
 * This scenario proves the mechanics the grant now permits. Note what it deliberately does not
 * prove: `buildRunners` grants every tool here, so this passing says nothing about whether the
 * real P5 roster hands those tools out. That is asserted separately, against `buildRoster`,
 * because the roster is where the defect actually lived.
 */
export async function runClaimCirculates(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "claim-circulates",
): Promise<ClaimCirculatesResult> {
  const quantity = "500";
  const buyer = runners.ORCHESTRATOR;
  const first = devnet.agents["WORKER-CODE"];
  const second = devnet.agents["WORKER-EXTRACT"];

  const headroomOf = async (issuer: Hex, turn: number): Promise<bigint> => {
    const rec = await buyer.callTool(
      "check_headroom",
      { issuer, classId: CLASS_CODE },
      { turn, jobId },
    );
    return BigInt((rec.result as { totalHeadroom: string }).totalHeadroom);
  };
  const balanceOf = async (who: Hex, tokenId: string, turn: number): Promise<bigint> => {
    const rec = await buyer.callTool(
      "get_balances",
      { account: who, tokenIds: [tokenId] },
      { turn, jobId },
    );
    const balances = (rec.result as { claims: { tokenId: string; balance: string }[] }).claims;
    return BigInt(balances.find((b) => b.tokenId === tokenId)?.balance ?? "0");
  };

  // Hop 1: the buyer pays the first worker in fSIU. Called with the tool's own full argument
  // set — the loop normally fills the class, window bounds and attestation in for an agent.
  const now = Math.floor(Date.now() / 1000);
  const windowTo = now + 1200;
  const rateAttestation = await signDryLoopRateAttestation(devnet, windowTo);
  const paid = await buyer.callTool(
    "pay_with_claim",
    {
      to: first.address,
      quantity,
      classId: CLASS_CODE,
      windowFrom: now - 60,
      windowTo,
      ...rateAttestation,
    },
    { turn: 1, jobId },
  );
  const { tokenId, issuer } = paid.result as { tokenId: string; issuer: Hex };
  const headroomBefore = await headroomOf(issuer, 2);
  const firstHolderAfterPayment = await balanceOf(first.address as Hex, tokenId, 3);

  // Hop 2: the first worker passes the SAME claim on, without redeeming it. This is the step
  // that has never occurred, and the one that distinguishes money from a settlement rail.
  await runners["WORKER-CODE"].callTool(
    "transfer_claim",
    { to: second.address, tokenId, quantity },
    { turn: 4, jobId },
  );
  const firstHolderAfterPassingOn = await balanceOf(first.address as Hex, tokenId, 5);
  const secondHolderAfterPassingOn = await balanceOf(second.address as Hex, tokenId, 6);

  // The second holder redeems what it was handed — the thing WORKER-EXTRACT could not do.
  await runners["WORKER-EXTRACT"].callTool(
    "redeem_claim",
    { tokenId, taskSpecHash: `0x${"55".repeat(32)}` },
    { turn: 7, jobId },
  );
  const issuerAgentId: AgentId =
    issuer.toLowerCase() === (devnet.agents["ISSUER-A"].address as string).toLowerCase()
      ? "ISSUER-A"
      : "ISSUER-B";
  await runners[issuerAgentId].callTool(
    "serve_redemption",
    { tokenId, holder: second.address, quantity, passed: true, receiptRef: `0x${"66".repeat(32)}` },
    { turn: 8, jobId },
  );

  return {
    tokenId,
    issuer,
    quantity,
    firstHolderAfterPayment,
    firstHolderAfterPassingOn,
    secondHolderAfterPassingOn,
    secondHolderAfterRedemption: await balanceOf(second.address as Hex, tokenId, 9),
    headroomBefore,
    headroomAfterDelivery: await headroomOf(issuer, 10),
  };
}
