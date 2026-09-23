import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import { computeTimeToExpirySeconds } from "../context/expiry.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  tokenId: z.string(),
  taskSpecHash: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Holder-side: `WorkClaim.presentForRedemption`. Separate from `serve_redemption` (issuer-side)
 * because the two are called by different agents — matching spec §10's literal 10-tool list.
 *
 * Also the one real, already-existing "redeem decision" point this substrate can log
 * `time_to_expiry` for without a turn loop (spec §7.1a, pre-WP-7 fix, 2026-09-23) —
 * `timeToExpirySeconds` is real, read from the claim's actual on-chain window
 * (`ChainReader.claimWindow`) against the chain's own clock (`currentBlockTimestamp`, not
 * `Date.now()` — an anvil devnet's clock can be warped independent of wall time, the same lesson
 * `default-and-reroute.ts`'s `advanceTime` already established), not derived from wall-clock
 * guesswork. "Hold" decisions (a turn where an agent *could* redeem but doesn't) need WP-7's own
 * turn loop to exist to be logged at all — this tool only covers the decision it can see.
 */
export const redeemClaimTool: ToolDefinition<
  Args,
  { txHash: string; timeToExpirySeconds: number }
> = {
  name: "redeem_claim",
  argsSchema,
  async handler(ctx, args) {
    const tokenId = BigInt(args.tokenId);
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "presentForRedemption",
      args: [tokenId, args.taskSpecHash as Hex],
    });

    const [{ windowTo }, now] = await Promise.all([
      ctx.deps.chainReader.claimWindow(tokenId),
      ctx.deps.chainReader.currentBlockTimestamp(),
    ]);
    const timeToExpirySeconds = computeTimeToExpirySeconds(now, windowTo);

    return { txHash: receipt.transactionHash, timeToExpirySeconds };
  },
};
