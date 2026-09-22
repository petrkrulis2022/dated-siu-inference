import { z } from "zod";
import type { Hex } from "viem";
import type { ToolDefinition } from "./types.js";

const argsSchema = z.object({
  issuer: z.string(),
  classId: z.string(),
});

type Args = z.infer<typeof argsSchema>;

/**
 * `CapacityBond.headroom`/`issuanceLimit` are already integer mSIU counts, not dollar figures —
 * unlike `get_balances`' USDC value, there is no natural decimal-USD arm to pair headroom with
 * without also taking a print rate as input (which spec §10's tool list doesn't ask for on this
 * tool). No F3 dual-render here for that reason — real chain reads only, via `ChainReader`.
 */
export const checkHeadroomTool: ToolDefinition<Args, { headroom: string; issuanceLimit: string }> =
  {
    name: "check_headroom",
    argsSchema,
    async handler(ctx, args) {
      const [headroom, issuanceLimit] = await Promise.all([
        ctx.deps.chainReader.headroom(args.issuer as Hex, args.classId as Hex),
        ctx.deps.chainReader.issuanceLimit(args.issuer as Hex, args.classId as Hex),
      ]);
      return { headroom: headroom.toString(), issuanceLimit: issuanceLimit.toString() };
    },
  };
