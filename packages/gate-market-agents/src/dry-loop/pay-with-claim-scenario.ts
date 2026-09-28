import type { Hex } from "viem";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";
import type { DevnetHandle } from "../devnet/deploy.js";
import { CLASS_CODE } from "../devnet/deploy.js";
import { signDryLoopRateAttestation } from "./context.js";

export interface PayWithClaimScenarioResult {
  tokenId: string;
  issuer: Hex;
  recipientBalanceAfter: bigint;
  callerBalanceAfter: bigint;
}

/**
 * `pay_with_claim` had no real-devnet coverage before 2026-09-28 — every other on-chain-writing
 * tool has one, but this one only ever ran live, and its first real live use (P5 window 1)
 * confirmed nothing was structurally broken by luck rather than by proof. Found live,
 * 2026-09-28, first real three-window run: the tool's *second* write (the transfer) reverted
 * `ERC1155InsufficientBalance` even though the *first* write (the mint) had genuinely confirmed —
 * a classic RPC-lag false rejection, the same family `@touchstone/sdk`'s `retryUntilConclusive`
 * already names three prior instances of. Fixed by reading the caller's own real balance until
 * conclusive between the two writes, mirroring `escrow-client.ts`'s `openAndFund`.
 *
 * This scenario cannot reproduce RPC lag itself (a single local anvil node has none), so it
 * exists to prove the fix does not change ordinary, unlagged behaviour — a real mint followed by
 * a real transfer, both genuinely confirmed, ending with the recipient holding the claim and the
 * caller holding none of it.
 */
export async function runPayWithClaimScenario(
  devnet: DevnetHandle,
  runners: Record<AgentId, Runner>,
  jobId = "pay-with-claim-scenario",
): Promise<PayWithClaimScenarioResult> {
  const buyer = runners.ORCHESTRATOR;
  const recipient = devnet.agents["WORKER-CODE"];

  const now = Math.floor(Date.now() / 1000);
  const windowFrom = now - 60;
  const windowTo = now + 3600;
  const rateAttestation = await signDryLoopRateAttestation(devnet, windowTo);

  const record = await buyer.callTool(
    "pay_with_claim",
    {
      to: recipient.address,
      quantity: "500",
      classId: CLASS_CODE,
      windowFrom,
      windowTo,
      ...rateAttestation,
    },
    { turn: 1, jobId },
  );
  const result = record.result as { tokenId: string; issuer: Hex };

  const balancesRecord = await buyer.callTool(
    "get_balances",
    { account: recipient.address, tokenIds: [result.tokenId] },
    { turn: 2, jobId },
  );
  const recipientBalanceAfter = BigInt(
    (balancesRecord.result as { claims: Array<{ tokenId: string; balance: string }> }).claims[0]
      .balance,
  );

  const callerBalancesRecord = await buyer.callTool(
    "get_balances",
    { account: devnet.agents.ORCHESTRATOR.address, tokenIds: [result.tokenId] },
    { turn: 3, jobId },
  );
  const callerBalanceAfter = BigInt(
    (callerBalancesRecord.result as { claims: Array<{ tokenId: string; balance: string }> })
      .claims[0].balance,
  );

  return {
    tokenId: result.tokenId,
    issuer: result.issuer,
    recipientBalanceAfter,
    callerBalanceAfter,
  };
}
