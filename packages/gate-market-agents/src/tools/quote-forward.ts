import { z } from "zod";
import type { Hex } from "viem";
import type { ToolDefinition } from "./types.js";
import { resolveClassId } from "./class-id.js";

/**
 * `quote_forward` — an issuer states its own terms for a window that has not started yet.
 *
 * The one place in this roster where a seller names its own price. `issue_quote` cannot do it:
 * it signs the exact body a buyer proposed, for one immediate job. An issuer watching its own
 * pool drain across windows has something to say that the existing pair has no way to express.
 *
 * Off-chain by construction, and disclosed as such everywhere it surfaces (see
 * `loop/forward-book.ts`): this records a stated price, it does not create an instrument. A claim
 * still mints at the published print rate against a publisher-signed attestation, so nothing here
 * binds the issuer or the buyer. Making it binding would mean a new contract and a new instrument,
 * which is outside what this testbed is allowed to build.
 *
 * The issuer's own headroom is read from chain at the moment of quoting and recorded with the
 * offer — an offer of 20,000 mSIU from an issuer holding 200 is a different datum from the same
 * number offered against real capacity, and the record should be able to tell them apart.
 */
const argsSchema = z.object({
  /** 1-based, and must be later than the window this is stated in — the loop enforces that. */
  forWindow: z.number().int().positive(),
  /** Decimal USD per SIU. The issuer's own number: nothing suggests one. */
  rateUsdPerSiu: z.string(),
  /** mSIU the issuer says it will make available at that rate. */
  maxQuantityMilliSiu: z.string(),
  /** Spliced by the loop from the job, never named by the model. */
  classId: z.string(),
  /** Spliced by the loop: the issuer's own address, so the headroom recorded is genuinely its
   * own rather than whichever address a model happened to type. */
  issuerAddress: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface QuoteForwardResult {
  forWindow: number;
  rateUsdPerSiu: string;
  maxQuantityMilliSiu: string;
  /** Read from chain at the moment of quoting, not taken from the model. */
  issuerHeadroomAtQuote: string;
  binding: false;
  note: string;
}

export const quoteForwardTool: ToolDefinition<Args, QuoteForwardResult> = {
  name: "quote_forward",
  argsSchema,
  async handler(ctx, args) {
    if (!/^\d+(\.\d+)?$/.test(args.rateUsdPerSiu)) {
      throw new Error(
        `quote_forward: rateUsdPerSiu must be a plain decimal USD string, got "${args.rateUsdPerSiu}".`,
      );
    }
    const quantity = BigInt(args.maxQuantityMilliSiu);
    if (quantity <= 0n) {
      throw new Error("quote_forward: maxQuantityMilliSiu must be a positive whole number of mSIU.");
    }

    const headroom = await ctx.deps.chainReader.headroom(
      args.issuerAddress as Hex,
      resolveClassId(args.classId),
    );

    return {
      forWindow: args.forWindow,
      rateUsdPerSiu: args.rateUsdPerSiu,
      maxQuantityMilliSiu: quantity.toString(),
      issuerHeadroomAtQuote: headroom.toString(),
      binding: false,
      note:
        "Recorded. This is a stated price, not a contract: nothing on-chain holds you to it, and " +
        "a claim minted in that window still prices at the published print rate. It is recorded " +
        "whether or not anyone takes it.",
    };
  },
};
