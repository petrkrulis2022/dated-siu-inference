import { z } from "zod";
import { openAndFund } from "@touchstone/agents";
import { quoteHashHex, type TouchstoneQuote } from "@touchstone/sdk";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  quote: z.custom<TouchstoneQuote>(),
  settler: z.string(),
});

type Args = z.infer<typeof argsSchema>;

function addressFromErc8004Id(id: string): string {
  const address = id.replace(/^erc8004:/, "");
  if (address === id) {
    throw new Error(`pay: expected an "erc8004:0x..." seller_id, got "${id}".`);
  }
  return address;
}

/**
 * Wraps `@touchstone/agents`' `openAndFund` directly — its approve-if-needed and RPC-lag retry
 * logic (both hit live on real Base Sepolia during that package's own development) are real
 * fixes, not reimplemented here.
 */
export const payTool: ToolDefinition<Args, { txHash: string }> = {
  name: "pay",
  argsSchema,
  spendUsd: (args) => args.quote.amount_usd_max,
  async handler(ctx, args) {
    const maxAmount = BigInt(args.quote.settlement[0].amount_max);
    const expiryUnix = BigInt(Math.floor(new Date(args.quote.expiry).getTime() / 1000));
    const txHash = await openAndFund(
      ctx.clients,
      args.quote.settlement[0].address,
      ctx.deps.escrowAddress,
      {
        quoteHash: quoteHashHex(args.quote),
        seller: addressFromErc8004Id(args.quote.seller_id),
        settler: args.settler,
        maxAmount,
        expiryUnix,
      },
    );
    return { txHash };
  },
};
