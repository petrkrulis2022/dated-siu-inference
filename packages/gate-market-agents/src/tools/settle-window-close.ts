import { z } from "zod";
import type { Hex } from "viem";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  tokenId: z.string(),
  holder: z.string(),
  /** A pre-signed rate attestation — only actually checked on-chain when this settlement turns
   * out to be a Default (WorkClaim.sol's own doc comment: never verified on the Expire path).
   * An Expire-only caller may pass empty/zero placeholders here; see chain/rate-attestation.ts
   * for the real signer a Default-expecting caller must use instead. */
  printId: z.string(),
  nanoUsdPerSiu: z.string(),
  validUntil: z.string(),
  signature: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * `settle_window_close` — spec §4.4's DEFAULT operation, permissionless
 * (`WorkClaim.settleWindowClose` — the destination is fixed by state, so calling it adds
 * liveness without adding authority). Like `transfer_claim`, not named in §10's WP-4 tool-list
 * bullet even though the loop cannot reach the Defaulted/Expired terminal states without it —
 * added for the same reason.
 */
export const settleWindowCloseTool: ToolDefinition<Args, { txHash: string }> = {
  name: "settle_window_close",
  argsSchema,
  async handler(ctx, args) {
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "settleWindowClose",
      args: [
        BigInt(args.tokenId),
        args.holder as Hex,
        {
          printId: args.printId,
          nanoUsdPerSiu: BigInt(args.nanoUsdPerSiu),
          validUntil: BigInt(args.validUntil),
        },
        args.signature as Hex,
      ],
    });
    return { txHash: receipt.transactionHash };
  },
};
