import { z } from "zod";
import type { Hex } from "viem";
import { minorUnitsToUsd } from "@touchstone/sdk";
import type { DualRenderRecord } from "../context/dual-render.js";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  account: z.string(),
  tokenIds: z.array(z.string()).default([]),
  /** Quote hashes of escrows this account is party to — spliced by the loop from the quote
   * board, not supplied by the model. The escrow contract exposes a mapping rather than an
   * enumeration, so there is no way to discover these on-chain; without them a paid seller sees
   * an unchanged wallet and concludes, correctly but uselessly, that it has not been paid. */
  escrowQuoteHashes: z.array(z.string()).default([]),
});

type Args = z.infer<typeof argsSchema>;

export interface BalancesResult {
  usdc: DualRenderRecord;
  claims: Array<{ tokenId: string; balance: string }>;
  /** Escrows this account is party to. `status: "open"` with this account as `seller` means the
   * money is committed and waiting on a `settle_escrow` call — it is not in the wallet above and
   * never will be until that call is made. */
  /** Absent when the run settles by direct transfer (`RunnerDeps.directSettlement`): there is no escrow to report. */
  escrows?: Array<{
    quoteHash: string;
    status: string;
    role: "seller" | "buyer" | "not a party";
    amountUsd: string;
    expiryUnix: string;
  }>;
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

    const account = args.account.toLowerCase();
    const escrows = await Promise.all(
      args.escrowQuoteHashes.map(async (quoteHash) => {
        const state = await ctx.deps.chainReader.escrowState(
          ctx.deps.escrowAddress as Hex,
          quoteHash as Hex,
        );
        const role =
          state.seller.toLowerCase() === account
            ? ("seller" as const)
            : state.buyer.toLowerCase() === account
              ? ("buyer" as const)
              : ("not a party" as const);
        return {
          quoteHash,
          status: state.status,
          role,
          amountUsd: minorUnitsToUsd(state.maxAmountMinorUnits.toString()),
          expiryUnix: state.expiryUnix.toString(),
        };
      }),
    );

    return ctx.deps.directSettlement === true ? { usdc, claims } : { usdc, claims, escrows };
  },
};
