import { z } from "zod";
import { buildQuoteBody, type QuoteBody } from "@touchstone/sdk";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  siu: z.string(),
  model: z.string(),
  rateUsdPerSiu: z.string(),
  indexVersion: z.string(),
  printId: z.string(),
  printHash: z.string(),
  sellerId: z.string(),
  chain: z.string(),
  expiresInSeconds: z.number().int().positive(),
  pattern: z.enum(["fixed", "estimate", "cap"]),
  siuMax: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

/** Wraps `@touchstone/sdk`'s `buildQuoteBody` directly — no new quote-construction logic here. */
export const requestQuoteTool: ToolDefinition<Args, QuoteBody> = {
  name: "request_quote",
  argsSchema,
  async handler(_ctx, args) {
    if (args.pattern === "fixed") {
      return buildQuoteBody({ ...args, pattern: "fixed" });
    }
    if (!args.siuMax) {
      throw new Error(`request_quote: pattern "${args.pattern}" requires siuMax.`);
    }
    return buildQuoteBody({ ...args, pattern: args.pattern, siuMax: args.siuMax });
  },
};
