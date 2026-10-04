import { z } from "zod";
import { parseEventLogs, type Hex } from "viem";
import { WORK_CLAIM_ABI, WORK_CLAIM_SETTLEMENT_EVENTS_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  tokenId: z.string(),
  holder: z.string(),
  /** A pre-signed rate attestation — only actually checked on-chain when this settlement turns
   * out to be a Default (WorkClaim.sol's own doc comment: never verified on the Expire path).
   * An Expire-only caller may pass empty/zero placeholders here; see chain/rate-attestation.ts
   * for the real signer a Default-expecting caller must use instead. `series` must equal the
   * claim's own grade and `printDate` the calendar day its window actually closed on, or a real
   * Default reverts with `SeriesMismatch`/`StalePrintDate` (added 2026-09-27). */
  printId: z.string(),
  series: z.string(),
  printDate: z.string(),
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
export interface SettleWindowCloseResult {
  txHash: string;
  /**
   * Which terminal state the claim reached, decoded from this transaction's own receipt: a presented
   * claim the issuer did not serve **Defaulted** (the bond paid the holder), one never presented
   * **Expired** (nobody was paid). Absent only if the receipt carried neither event, which is
   * recorded as absent and never guessed — a count built from a guess is not a count.
   */
  outcome?: "Defaulted" | "Expired";
  /** Integer USDC minor units the bond paid the holder; present exactly when `outcome` is Defaulted. */
  bondPaidMinorUnits?: string;
}

export const settleWindowCloseTool: ToolDefinition<Args, SettleWindowCloseResult> = {
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
          series: args.series as Hex,
          printDate: BigInt(args.printDate),
          nanoUsdPerSiu: BigInt(args.nanoUsdPerSiu),
          validUntil: BigInt(args.validUntil),
        },
        args.signature as Hex,
      ],
    });
    const workClaim = (ctx.deps.deployment.workClaim.address as string).toLowerCase();
    const settlements = parseEventLogs({
      abi: WORK_CLAIM_SETTLEMENT_EVENTS_ABI,
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === workClaim),
    }).filter((e) => e.args.tokenId === BigInt(args.tokenId));
    const reached = settlements[0];
    return {
      txHash: receipt.transactionHash,
      ...(reached?.eventName === "Defaulted"
        ? { outcome: "Defaulted" as const, bondPaidMinorUnits: reached.args.amountUsdc.toString() }
        : reached?.eventName === "Expired"
          ? { outcome: "Expired" as const }
          : {}),
    };
  },
};
