import { z } from "zod";
import { decodeEventLog, type Hex } from "viem";
import { minorUnitsToUsd } from "@touchstone/sdk";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import { usdcPaidBy } from "../chain/usdc-paid.js";
import type { ToolDefinition } from "./types.js";
import { resolveClassId } from "./class-id.js";

const argsSchema = z.object({
  classId: z.string(),
  /** Which Touchstone Assay grade this claim settles against — must equal the attestation's own
   * `series` (the attestation is pre-signed for one series; this is that same value, used for
   * both the claim's own grade and the on-chain `SeriesMismatch` check in one field, since a real
   * caller always controls both together). Same `bytes32` hex encoding `classId` already uses. */
  series: z.string(),
  quantity: z.string(),
  windowFrom: z.number().int(),
  windowTo: z.number().int(),
  /** A pre-signed RateAttestationVerifier.RateAttestation (packages/contracts/src/
   * RateAttestationVerifier.sol) plus its signature — never produced by this tool itself, which
   * has no access to the publisher key. `nanoUsdPerSiu`/`validUntil`/`printDate` are decimal
   * strings (repo convention: no floats in money maths), parsed to bigint in the handler. See
   * chain/rate-attestation.ts for the real signer this attestation must come from. */
  printId: z.string(),
  printDate: z.string(),
  nanoUsdPerSiu: z.string(),
  validUntil: z.string(),
  signature: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/** `spendUsd` estimates the USDC this mint pulls from the caller — quantity (mSIU) *
 * nanoUsdPerSiu / 1_000_000, mirroring `WorkClaim._usdcAmount`'s own formula exactly so the
 * budget ceiling sees the same number the contract will actually charge. */
function estimatedSpendUsd(args: Args): string {
  const totalMicroUsd = (BigInt(args.quantity) * BigInt(args.nanoUsdPerSiu)) / 1_000_000n;
  return minorUnitsToUsd(totalMicroUsd.toString());
}

export const mintClaimTool: ToolDefinition<
  Args,
  { txHash: string; tokenId: string; issuer: string; mintCostMinorUnits: string }
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

    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: WORK_CLAIM_ABI, ...log });
        if (decoded.eventName === "Minted") {
          return {
            txHash: receipt.transactionHash,
            tokenId: decoded.args.tokenId.toString(),
            issuer: decoded.args.issuer,
            // Read from the receipt's own USDC transfer, not recomputed from the contract's formula.
            mintCostMinorUnits: usdcPaidBy(
              receipt,
              ctx.deps.deployment.usdc.address,
              ctx.clients.account.address,
            ).toString(),
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
