import { z } from "zod";
import type { Hex } from "viem";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  /** Omit to see every issuer bonded in this class. Naming one narrows the answer to it. */
  issuer: z.string().optional(),
  classId: z.string(),
  /** Spliced by the loop — the delivery window this headroom would be reserved for. Headroom is
   * per (issuer, class) on-chain, so this labels the answer rather than filtering it. */
  windowLabel: z.string().optional(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * `CapacityBond.headroom`/`issuanceLimit` are already integer mSIU counts, not dollar figures —
 * unlike `get_balances`' USDC value, there is no natural decimal-USD arm to pair headroom with
 * without also taking a print rate as input (which spec §10's tool list doesn't ask for on this
 * tool). No F3 dual-render here for that reason — real chain reads only, via `ChainReader`.
 */
export interface HeadroomRow {
  issuer: string;
  headroom: string;
  issuanceLimit: string;
}

export interface HeadroomResult {
  windowLabel?: string;
  /** Every bonded issuer in the class unless one was named. Headroom is finite, shared between
   * all buyers, and consumed on a first-come-first-served basis by whoever mints first — so the
   * whole pool, not one issuer's slice, is what tells a buyer whether waiting is safe. */
  issuers: HeadroomRow[];
  totalHeadroom: string;
}

export const checkHeadroomTool: ToolDefinition<Args, HeadroomResult> = {
  name: "check_headroom",
  argsSchema,
  async handler(ctx, args) {
    const classId = args.classId as Hex;
    const issuers = args.issuer
      ? [args.issuer as Hex]
      : await ctx.deps.chainReader.issuersForClass(classId);

    const rows = await Promise.all(
      issuers.map(async (issuer) => {
        const [headroom, issuanceLimit] = await Promise.all([
          ctx.deps.chainReader.headroom(issuer, classId),
          ctx.deps.chainReader.issuanceLimit(issuer, classId),
        ]);
        return { issuer, headroom: headroom.toString(), issuanceLimit: issuanceLimit.toString() };
      }),
    );

    return {
      ...(args.windowLabel ? { windowLabel: args.windowLabel } : {}),
      issuers: rows,
      totalHeadroom: rows.reduce((sum, r) => sum + BigInt(r.headroom), 0n).toString(),
    };
  },
};
