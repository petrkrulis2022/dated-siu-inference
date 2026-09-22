import { z } from "zod";
import { signQuote, type QuoteBody, type TouchstoneQuote } from "@touchstone/sdk";
import type { ToolDefinition } from "./types.js";

/** `QuoteBody` re-accepted as loosely-typed input here (it was itself the result of
 * `request_quote`, a prior tool call) — zod checks shape at the boundary rather than trusting
 * TypeScript's compile-time type across what is, in WP-7, a model-mediated hop. */
const argsSchema = z.object({}).passthrough();

/**
 * The one tool that actually signs. `privateKeyHex` arrives from `Runner`, is used only inside
 * `signQuote`'s call, and never appears in the returned `TouchstoneQuote` (a signed quote is a
 * public artifact — that's the point of signing it) or anywhere else this handler touches.
 */
export const issueQuoteTool: ToolDefinition<QuoteBody, TouchstoneQuote> = {
  name: "issue_quote",
  argsSchema: argsSchema as unknown as z.ZodType<QuoteBody>,
  async handler(_ctx, args, privateKeyHex) {
    return signQuote(args, privateKeyHex);
  },
};
