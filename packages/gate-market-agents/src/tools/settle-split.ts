import { z } from "zod";
import { openAndFund } from "@touchstone/agents";
import type { TouchstoneQuote } from "@touchstone/sdk";
import { quoteHashHex } from "@touchstone/sdk";
import type { ToolDefinition } from "./types.js";
import { payWithClaimTool } from "./pay-with-claim.js";

const argsSchema = z.object({
  quote: z.custom<TouchstoneQuote>(),
  settler: z.string(),
  /** How much of this quote to settle in fSIU, in milli-SIU. The dollar leg is the remainder. */
  claimQuantityMilliSiu: z.string(),
  /** The claim leg's mint arguments, supplied by the loop exactly as for `pay_with_claim`. */
  to: z.string(),
  classId: z.string(),
  series: z.string(),
  windowFrom: z.number().int(),
  windowTo: z.number().int(),
  printId: z.string(),
  printDate: z.string(),
  nanoUsdPerSiu: z.string(),
  validUntil: z.string(),
  signature: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface SettleSplitResult {
  claimTokenId: string;
  claimIssuer: string;
  claimQuantityMilliSiu: string;
  claimValueUsdcMinorUnits: string;
  usdcMinorUnits: string;
  escrowTxHash: string;
  claimMintTxHash: string;
  /** Claim share of the quote, 0..1 as a decimal string — the figure F1 actually wants. */
  claimShare: string;
}

function addressFromErc8004Id(id: string): string {
  const address = id.replace(/^erc8004:/, "");
  if (!address.startsWith("0x")) {
    throw new Error(`settle_split: expected an "erc8004:0x..." seller_id, got "${id}".`);
  }
  return address;
}

/**
 * Settles ONE quote partly in fSIU and partly in USDC, in a single call.
 *
 * ## Why one call and not two
 *
 * A split is, at the contract level, exactly two independent actions: a claim never enters the
 * escrow (`pay_with_claim` mints and transfers an ERC-1155 directly), and `openAndFund` already
 * takes `maxAmount` as its own parameter, so a partial dollar leg needs no contract change. Two
 * sequential tool calls would therefore work.
 *
 * They would also cost TWO TURNS where an all-or-nothing choice costs one, and that asymmetry is
 * precisely what manufactured the "9 of 9 chose fSIU" figure (spec §4.6f): agents avoided the
 * three-turn dollar route for turn-budget reasons and it read as a preference. Shipping splits
 * as two calls would rebuild that confound in a new place and under-report every split. Turn
 * symmetry — not contract difficulty — is the reason this is atomic.
 *
 * ## The quote hash survives the split
 *
 * The dollar leg opens the escrow under the ORIGINAL quote's hash with a reduced `maxAmount`.
 * `openAndFund` takes the two independently, so the seller still settles the quote it signed;
 * rewriting the quote body to carry a smaller amount would change its hash and break that link.
 * `settle_escrow` already permits settling for less than the quoted maximum.
 */
export const settleSplitTool: ToolDefinition<Args, SettleSplitResult> = {
  name: "settle_split",
  // Only the dollar leg is USD spend; the claim leg consumes bonded capacity, not the buyer's
  // USDC budget, and charging the ceiling for both would make a split look twice as expensive
  // as either pure route — another turn-cost-shaped thumb on the scale.
  spendUsd: (args) => {
    const quoted = BigInt(args.quote.settlement[0].amount_max);
    const claimValue = claimValueMinorUnits(args.claimQuantityMilliSiu, args.nanoUsdPerSiu);
    const usdcLeg = quoted > claimValue ? quoted - claimValue : 0n;
    return (Number(usdcLeg) / 1_000_000).toFixed(6);
  },
  argsSchema,
  async handler(ctx, args, privateKeyHex) {
    const quoted = BigInt(args.quote.settlement[0].amount_max);
    const claimValue = claimValueMinorUnits(args.claimQuantityMilliSiu, args.nanoUsdPerSiu);
    if (claimValue > quoted) {
      throw new Error(
        `settle_split: ${args.claimQuantityMilliSiu} mSIU is worth ${claimValue} USDC minor units ` +
          `at the attested rate, more than the quote's own ${quoted}. A split cannot exceed what ` +
          `is being bought.`,
      );
    }
    const usdcLeg = quoted - claimValue;

    // Claim leg first: it can fail on headroom, and failing before any money moves is the
    // recoverable order. An escrow opened against a claim leg that then reverts would leave the
    // buyer's USDC locked against a quote it cannot complete.
    const claim = await payWithClaimTool.handler(
      ctx,
      {
        to: args.to,
        quantity: args.claimQuantityMilliSiu,
        classId: args.classId,
        series: args.series,
        windowFrom: args.windowFrom,
        windowTo: args.windowTo,
        printId: args.printId,
        printDate: args.printDate,
        nanoUsdPerSiu: args.nanoUsdPerSiu,
        validUntil: args.validUntil,
        signature: args.signature,
      },
      privateKeyHex,
    );

    const escrowTxHash =
      usdcLeg === 0n
        ? ""
        : await openAndFund(ctx.clients, args.quote.settlement[0].address, ctx.deps.escrowAddress, {
            quoteHash: quoteHashHex(args.quote),
            seller: addressFromErc8004Id(args.quote.seller_id),
            settler: args.settler,
            maxAmount: usdcLeg,
            expiryUnix: BigInt(Math.floor(new Date(args.quote.expiry).getTime() / 1000)),
          });

    return {
      claimTokenId: claim.tokenId,
      claimIssuer: claim.issuer,
      claimQuantityMilliSiu: args.claimQuantityMilliSiu,
      claimValueUsdcMinorUnits: claimValue.toString(),
      usdcMinorUnits: usdcLeg.toString(),
      escrowTxHash,
      claimMintTxHash: claim.mintTxHash,
      claimShare: quoted === 0n ? "0" : (Number(claimValue) / Number(quoted)).toFixed(4),
    };
  },
};

/**
 * mSIU at nanoUSD/SIU, in USDC minor units, as integers throughout — invariant 4, no floats in
 * money maths. q mSIU is q/1000 SIU; r nanoUSD/SIU is r/1e9 USD; USDC has 6 decimals. So
 * minor = (q/1000) * (r/1e9) * 1e6 = q*r/1e6. Checked against a real settlement: 10,000 mSIU at
 * 1,427,000 nanoUSD/SIU drew exactly 14,270 minor units from a bond on 2026-09-30.
 */
export function claimValueMinorUnits(quantityMilliSiu: string, nanoUsdPerSiu: string): bigint {
  return (BigInt(quantityMilliSiu) * BigInt(nanoUsdPerSiu)) / 1_000_000n;
}
