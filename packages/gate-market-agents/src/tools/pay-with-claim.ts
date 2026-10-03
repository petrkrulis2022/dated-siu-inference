import { z } from "zod";
import { decodeEventLog, type Hex } from "viem";
import { minorUnitsToUsd, retryUntilConclusive } from "@touchstone/sdk";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";
import { resolveClassId } from "./class-id.js";

/**
 * `pay_with_claim` — paying a counterparty in fSIU in a single tool call.
 *
 * Exists to remove a measurement confound, not to add capability. In the first real P5 window the
 * orchestrator paid in USDC, and that looked like an asset preference until the tool surface was
 * counted: paying in USDC was one call (`pay`), paying in fSIU was three (`mint_claim`,
 * `transfer_claim`, and the recipient's own `redeem_claim`). An agent choosing the shorter path is
 * choosing the shorter path. F1 asks which instrument an agent prefers, so the two must cost the
 * same number of decisions or the answer measures the interface.
 *
 * Deliberately NOT atomic on-chain, and named honestly rather than papered over: this is one tool
 * call comprising two real transactions — `mint`, then `safeTransferFrom`. True atomicity would
 * need a router function on `WorkClaim` and another redeployment. If the mint succeeds and the
 * transfer fails, the claim stays with the caller, who still holds it and can move it with
 * `transfer_claim`; the result below reports exactly which of the two happened, so a run record
 * never shows a payment that half-occurred as if it had completed.
 *
 * Between the two writes, this reads the caller's own real balance of the freshly-minted token
 * until it is conclusive (`@touchstone/sdk`'s `retryUntilConclusive`) rather than submitting the
 * transfer the instant the mint receipt confirms. Found live, 2026-09-28, the first real
 * three-window run: the mint had genuinely confirmed (re-querying moments later showed the
 * correct balance) but the transfer's own pre-flight gas-estimation eth_call hit a different,
 * lagging node in Base Sepolia's load-balanced RPC pool and reverted `ERC1155InsufficientBalance`
 * against a caller who, by every other measure, already held the tokens — the same failure mode
 * `escrow-client.ts`'s `openAndFund` already names three prior instances of, hit here as a
 * fourth. Only a conclusive read is a fact; an inconclusive one is retried, never trusted.
 */
const argsSchema = z.object({
  /** Recipient address — the loop resolves a symbolic `{ agentId }` to this, same as
   * `transfer_claim`. */
  to: z.string(),
  quantity: z.string(),
  classId: z.string(),
  series: z.string(),
  windowFrom: z.number().int(),
  windowTo: z.number().int(),
  printId: z.string(),
  printDate: z.string(),
  nanoUsdPerSiu: z.string(),
  validUntil: z.string(),
  signature: z.string(),
  /**
   * The payer's own one-line statement of what this payment is for, carried into the
   * recipient's arrival notice.
   *
   * Added 2026-10-03 after run 17 (fsiu-design.md §4.3a). The dollar route cannot lose this:
   * `pay` settles a quote the seller itself issued against a named request, so a USDC-paid
   * seller always knows what it was paid for. The claim route needs no counterparty consent and
   * carried no counterparty information either — a claim simply appeared, and run 17's holder
   * asked, in its own friction log, "whether this claim was meant as payment for a
   * gate-authoring job I'm expected to produce, or is simply an independent position I now
   * hold".
   *
   * Optional, never required, never validated, and never prompted for — the same discipline as
   * `rationale` (§4.6aa). A memo that an agent must write is a memo that gets written whether or
   * not it means anything, and a required field would make the two routes differ in how much
   * work paying takes, which is the §4.6f confound this tool exists to remove.
   */
  memo: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface PayWithClaimResult {
  mintTxHash: string;
  transferTxHash: string;
  tokenId: string;
  issuer: string;
  quantity: string;
}

/** Same formula as `mint_claim`'s, and the same reason: the budget ceiling must see the number
 * the contract will actually charge, not an estimate of it. */
function estimatedSpendUsd(args: Args): string {
  const totalMicroUsd = (BigInt(args.quantity) * BigInt(args.nanoUsdPerSiu)) / 1_000_000n;
  return minorUnitsToUsd(totalMicroUsd.toString());
}

export const payWithClaimTool: ToolDefinition<Args, PayWithClaimResult> = {
  name: "pay_with_claim",
  argsSchema,
  spendUsd: estimatedSpendUsd,
  async handler(ctx, args) {
    const workClaim = ctx.deps.deployment.workClaim.address as Hex;

    const mintReceipt = await writeAndConfirm(ctx.clients, {
      address: workClaim,
      abi: WORK_CLAIM_ABI,
      functionName: "mint",
      args: [
        resolveClassId(args.classId),
        args.series as Hex,
        BigInt(args.quantity),
        BigInt(args.windowFrom),
        BigInt(args.windowTo),
        {
          printId: args.printId,
          series: args.series as Hex,
          printDate: BigInt(args.printDate),
          nanoUsdPerSiu: BigInt(args.nanoUsdPerSiu),
          validUntil: BigInt(args.validUntil),
        },
        args.signature as Hex,
      ],
    });

    let tokenId: string | undefined;
    let issuer: string | undefined;
    for (const log of mintReceipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: WORK_CLAIM_ABI, ...log });
        if (decoded.eventName === "Minted") {
          tokenId = decoded.args.tokenId.toString();
          issuer = decoded.args.issuer;
          break;
        }
      } catch {
        // Not a Minted log, or not decodable against this ABI — the same transaction also emits
        // ERC-1155 TransferSingle and the bond's own HeadroomConsumed.
      }
    }
    if (tokenId === undefined || issuer === undefined) {
      throw new Error(
        `pay_with_claim: minted in ${mintReceipt.transactionHash} but found no Minted event — the claim exists and is held by you; move it with transfer_claim.`,
      );
    }

    await retryUntilConclusive(
      () =>
        ctx.clients.publicClient.readContract({
          address: workClaim,
          abi: WORK_CLAIM_ABI,
          functionName: "balanceOf",
          args: [ctx.clients.account.address, BigInt(tokenId!)],
        }),
      (seen) => seen >= BigInt(args.quantity),
    );

    const transferReceipt = await writeAndConfirm(ctx.clients, {
      address: workClaim,
      abi: WORK_CLAIM_ABI,
      functionName: "safeTransferFrom",
      args: [ctx.clients.account.address, args.to as Hex, BigInt(tokenId), BigInt(args.quantity), "0x"],
    });

    return {
      mintTxHash: mintReceipt.transactionHash,
      transferTxHash: transferReceipt.transactionHash,
      tokenId,
      issuer,
      quantity: args.quantity,
    };
  },
};
