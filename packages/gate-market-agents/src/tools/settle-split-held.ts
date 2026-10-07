import { z } from "zod";
import type { Hex } from "viem";
import type { TouchstoneQuote } from "@touchstone/sdk";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { writeAndConfirm } from "../chain/write.js";
import { refuseExpired, sellerAddress, sendUsdc } from "./direct-settlement.js";
import { claimShareDecimal, claimValueMinorUnits, usdcLegUsd } from "./settle-split.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  quote: z.custom<TouchstoneQuote>(),
  /** The quote's seller, who receives both parts. */
  to: z.string(),
  /** The claim the first part is paid from. */
  tokenId: z.string(),
  /** How much of the quote to pay from the held claim, in milli-SIU. The rest is paid in USDC. */
  claimQuantityMilliSiu: z.string(),
  /** The print in force, in nano-USD per SIU: what the claim part is worth. */
  nanoUsdPerSiu: z.string(),
  memo: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

export interface SettleSplitHeldResult {
  tokenId: string;
  claimQuantityMilliSiu: string;
  claimValueUsdcMinorUnits: string;
  usdcMinorUnits: string;
  claimTxHash: string;
  usdcTxHash: string;
  /** The claim part's share of the quote's price, 0..1 as a decimal string. */
  claimShare: string;
}

/**
 * Settles ONE quote partly from a claim the caller already holds and partly in USDC, in a single call (D32).
 *
 * The split `settle_split` makes mints its claim part, which is paid for in USDC and draws on the issuer's headroom; the
 * lab, from v4, has no minting (D31), so a payment drawn from both of a wallet's assets takes its claim part from a
 * balance that already exists. Two plain transfers to the quote's seller, the claim part valued at the print and the USDC
 * part the rest of the quote's price. It needs a direct-settlement run (`RunnerDeps.directSettlement`): there is no escrow
 * for the USDC part to sit in.
 *
 * One call and not two, for the reason `settle_split` gives: turn symmetry. A payment in two parts that cost two turns
 * would be a route that is dearer than the others for a reason that has nothing to do with the asset.
 *
 * The claim part goes first. If the USDC part then fails the error says so and states what moved: a half-made payment
 * is never reported as made, and the report's balances are read from the chain.
 */
export const settleSplitHeldTool: ToolDefinition<Args, SettleSplitHeldResult> = {
  name: "settle_split_held",
  argsSchema,
  // Only the USDC part is USD spend; the claim part spends a claim the caller holds.
  spendUsd: (args) =>
    usdcLegUsd(BigInt(args.quote.settlement[0].amount_max), claimValueMinorUnits(args.claimQuantityMilliSiu, args.nanoUsdPerSiu)),
  async handler(ctx, args) {
    if (ctx.deps.directSettlement !== true) {
      throw new Error("settle_split_held: only a run that settles by direct transfer has this tool.");
    }
    if (!/^[1-9]\d*$/.test(args.claimQuantityMilliSiu)) {
      throw new Error(`settle_split_held: expected a positive whole number of milli-SIU, got "${args.claimQuantityMilliSiu}".`);
    }
    const quoted = BigInt(args.quote.settlement[0].amount_max);
    const claimValue = claimValueMinorUnits(args.claimQuantityMilliSiu, args.nanoUsdPerSiu);
    if (claimValue >= quoted) {
      throw new Error(
        `settle_split_held: ${args.claimQuantityMilliSiu} mSIU is worth ${claimValue} USDC minor units at the print; ` +
          `the claim part of a split must be worth less than the quote's ${quoted}.`,
      );
    }
    if (claimValue === 0n) {
      throw new Error(`settle_split_held: ${args.claimQuantityMilliSiu} mSIU is worth nothing at the print; the claim part must be worth something.`);
    }
    const usdcLeg = quoted - claimValue;
    await refuseExpired(ctx, args.quote, "settle_split_held");
    sellerAddress(args.quote, "settle_split_held");

    const claim = await writeAndConfirm(ctx.clients, {
      address: ctx.deps.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "safeTransferFrom",
      args: [ctx.clients.account.address, args.to as Hex, BigInt(args.tokenId), BigInt(args.claimQuantityMilliSiu), "0x"],
    });
    let usdcTxHash: string;
    try {
      usdcTxHash = await sendUsdc(ctx, args.to, usdcLeg);
    } catch (err) {
      throw new Error(
        `settle_split_held: the claim part moved (${args.claimQuantityMilliSiu} mSIU, tx ${claim.transactionHash}); ` +
          `the USDC part (${usdcLeg} minor units) did not: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        { cause: err },
      );
    }
    return {
      tokenId: args.tokenId,
      claimQuantityMilliSiu: args.claimQuantityMilliSiu,
      claimValueUsdcMinorUnits: claimValue.toString(),
      usdcMinorUnits: usdcLeg.toString(),
      claimTxHash: claim.transactionHash,
      usdcTxHash,
      claimShare: claimShareDecimal(claimValue, quoted),
    };
  },
};
