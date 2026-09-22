import { z } from "zod";
import type { Hex } from "viem";
import { minorUnitsToUsd } from "@touchstone/sdk";
import type { DualRenderRecord } from "../context/dual-render.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  account: z.string(),
  tokenIds: z.array(z.string()).default([]),
});

type Args = z.infer<typeof argsSchema>;

export interface BalancesResult {
  usdc: DualRenderRecord;
  claims: Array<{ tokenId: string; balance: string }>;
}

/** Real chain reads via `ChainReader` — no shadow ledger. USDC is rendered through the F3
 * dual-render hook (§7.3); claim balances are already integer mSIU counts, so there is no
 * decimal/integer pair to render for them. */
export const getBalancesTool: ToolDefinition<Args, BalancesResult> = {
  name: "get_balances",
  argsSchema,
  async handler(ctx, args) {
    const usdcMinorUnits = await ctx.deps.chainReader.usdcBalance(args.account as Hex);
    const usdc = ctx.dualRenderer.render(minorUnitsToUsd(usdcMinorUnits.toString()));

    const claims = await Promise.all(
      args.tokenIds.map(async (tokenId) => ({
        tokenId,
        balance: (
          await ctx.deps.chainReader.claimBalance(BigInt(tokenId), args.account as Hex)
        ).toString(),
      })),
    );

    return { usdc, claims };
  },
};
