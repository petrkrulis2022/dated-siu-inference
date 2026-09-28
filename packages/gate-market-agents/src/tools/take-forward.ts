import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * `take_forward` — a buyer records that it is acting on an issuer's stated forward terms.
 *
 * Deliberately does nothing on-chain, and says so to the caller. Its entire purpose is
 * measurement: an issuer's forward offer is only interesting if we can tell whether anyone took
 * it, and a buyer that mints in a later window leaves no trace of which offer, if any, it was
 * responding to. This is that trace.
 *
 * It does not pay, mint or reserve anything, and taking an offer commits neither side — the
 * buyer still pays for the work separately, at the published print rate, through whichever route
 * it chooses. Recording a take alongside the eventual payment is what lets a run report "offered
 * and taken", "offered and ignored" and "never offered" as three different outcomes instead of
 * collapsing the last two into silence.
 *
 * The offer's existence and openness are checked by the loop before this runs (`buildToolArgs`
 * resolves the id against the book, which outlives any one window), and the loop marks it taken
 * afterwards. This handler's job is only to say, in the model's own tool history, exactly what
 * did and did not just happen.
 */
const argsSchema = z.object({
  quoteId: z.string(),
  /** Spliced by the loop from the resolved offer — echoed back so the model's own history shows
   * the terms it took, not just an opaque id. */
  issuer: z.string(),
  rateUsdPerSiu: z.string(),
  maxQuantityMilliSiu: z.string(),
  forWindow: z.number().int().positive(),
});

type Args = z.infer<typeof argsSchema>;

export interface TakeForwardResult {
  quoteId: string;
  issuer: string;
  rateUsdPerSiu: string;
  maxQuantityMilliSiu: string;
  forWindow: number;
  paid: false;
  note: string;
}

export const takeForwardTool: ToolDefinition<Args, TakeForwardResult> = {
  name: "take_forward",
  argsSchema,
  async handler(_ctx, args) {
    return {
      quoteId: args.quoteId,
      issuer: args.issuer,
      rateUsdPerSiu: args.rateUsdPerSiu,
      maxQuantityMilliSiu: args.maxQuantityMilliSiu,
      forWindow: args.forWindow,
      paid: false,
      note:
        "Recorded that you took these terms. Nothing was paid, minted or reserved: this is a " +
        "record of your choice. You still buy the work itself separately, and a claim still " +
        "prices at the published print rate.",
    };
  },
};
