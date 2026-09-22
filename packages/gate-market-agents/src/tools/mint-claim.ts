import { z } from "zod";
import { decodeEventLog, type Hex } from "viem";
import { minorUnitsToUsd } from "@touchstone/sdk";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  classId: z.string(),
  quantity: z.string(),
  windowFrom: z.number().int(),
  windowTo: z.number().int(),
  /** microUsdPerSiu — see WorkClaim.sol's "Price precision" doc comment: an integer count of
   * millionths of a dollar per SIU, matching USDC's own 6 decimals. Passed as a decimal string
   * here (repo convention: no floats in money maths) and parsed to bigint in the handler. */
  microUsdPerSiu: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/** `spendUsd` estimates the USDC this mint pulls from the caller — quantity (mSIU) *
 * microUsdPerSiu / 1000, mirroring `WorkClaim._usdcAmount`'s own formula exactly so the budget
 * ceiling sees the same number the contract will actually charge. */
function estimatedSpendUsd(args: Args): string {
  const totalMicroUsd = (BigInt(args.quantity) * BigInt(args.microUsdPerSiu)) / 1000n;
  return minorUnitsToUsd(totalMicroUsd.toString());
}

export const mintClaimTool: ToolDefinition<
  Args,
  { txHash: string; tokenId: string; issuer: string }
> = {
  name: "mint_claim",
  argsSchema,
  spendUsd: estimatedSpendUsd,
  async handler(ctx, args) {
    const receipt = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "mint",
      args: [
        args.classId as Hex,
        BigInt(args.quantity),
        BigInt(args.windowFrom),
        BigInt(args.windowTo),
        BigInt(args.microUsdPerSiu),
      ],
    });

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: WORK_CLAIM_ABI, ...log });
        if (decoded.eventName === "Minted") {
          return {
            txHash: receipt.transactionHash,
            tokenId: decoded.args.tokenId.toString(),
            issuer: decoded.args.issuer,
          };
        }
      } catch {
        // Not a Minted log (or not decodable against this ABI) — skip, other events may share
        // the same transaction (e.g. the ERC-1155 TransferSingle this mint also emits).
      }
    }
    throw new Error(`mint_claim: no Minted event found in receipt ${receipt.transactionHash}.`);
  },
};
