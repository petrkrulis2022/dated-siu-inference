import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  tokenId: z.string(),
  taskSpecHash: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/** Holder-side: `WorkClaim.presentForRedemption`. Separate from `serve_redemption` (issuer-side)
 * because the two are called by different agents — matching spec §10's literal 10-tool list. */
export const redeemClaimTool: ToolDefinition<Args, { txHash: string }> = {
  name: "redeem_claim",
  argsSchema,
  async handler(ctx, args) {
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "presentForRedemption",
      args: [BigInt(args.tokenId), args.taskSpecHash as Hex],
    });
    return { txHash: receipt.transactionHash };
  },
};
