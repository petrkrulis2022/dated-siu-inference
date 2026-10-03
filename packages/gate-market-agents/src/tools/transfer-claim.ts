import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  to: z.string(),
  tokenId: z.string(),
  quantity: z.string(),
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

/**
 * `transfer` — spec §4.4's fourth core operation ("claim moves agent→agent, free, no print
 * read, no issuer involvement"), not named in §10's WP-4 tool-list bullet even though the loop
 * cannot function without it (WP-5's own "mint -> transfer -> present_for_redemption" script is
 * the proof). Added here rather than left as a gap: the same key-isolation principle every other
 * tool follows applies equally to a transfer — a model in WP-7 needs a tool to move a claim, not
 * a bare contract call it could never reach without seeing the key directly.
 */
export const transferClaimTool: ToolDefinition<Args, { txHash: string }> = {
  name: "transfer_claim",
  argsSchema,
  async handler(ctx, args) {
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "safeTransferFrom",
      args: [
        ctx.clients.account.address,
        args.to as Hex,
        BigInt(args.tokenId),
        BigInt(args.quantity),
        "0x",
      ],
    });
    return { txHash: receipt.transactionHash };
  },
};
