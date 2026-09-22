import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  tokenId: z.string(),
  holder: z.string(),
  quantity: z.string(),
  passed: z.boolean(),
  receiptRef: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Issuer-side: `WorkClaim.serveRedemption`. `passed` is the caller's own already-computed
 * verdict (from a prior `submit_job` call) — this tool reports it on-chain, it does not grade.
 * Invariant 3 ("failed work retires nothing") is enforced by the contract itself, fuzzed at
 * 10,000 runs (`packages/contracts/test/WorkClaim.invariant.t.sol`) — nothing here needs to
 * re-check it.
 */
export const serveRedemptionTool: ToolDefinition<Args, { txHash: string }> = {
  name: "serve_redemption",
  argsSchema,
  async handler(ctx, args) {
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "serveRedemption",
      args: [
        BigInt(args.tokenId),
        args.holder as Hex,
        BigInt(args.quantity),
        args.passed,
        args.receiptRef as Hex,
      ],
    });
    return { txHash: receipt.transactionHash };
  },
};
