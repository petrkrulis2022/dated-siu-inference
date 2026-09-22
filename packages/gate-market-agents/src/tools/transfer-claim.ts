import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  to: z.string(),
  tokenId: z.string(),
  quantity: z.string(),
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
