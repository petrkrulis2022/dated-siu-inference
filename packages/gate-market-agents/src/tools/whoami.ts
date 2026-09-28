import { z } from "zod";
import type { Hex } from "viem";
import { classIdFor, KNOWN_TASK_CLASSES } from "./class-id.js";
import type { ToolDefinition } from "./types.js";

/**
 * `whoami` — an agent's own identity and, if it is an issuer, its own bonded position.
 *
 * Added 2026-09-28, from a real run in which ISSUER-B spent nine of its fifteen turns and its
 * entire inference ceiling trying to find out who it was. Its own friction log, verbatim: "no
 * tool to read my own issuer address; inferred 0xD4Be… from issuance-limit math (400h × 0.08
 * SIU/h × 0.5 = 16000 mSIU)". It derived its own address from arithmetic — correctly — because
 * nothing would simply tell it. ISSUER-A logged the same gap independently.
 *
 * Nothing here is a decision or a hint: it is the agent's own address, whether it holds bonded
 * lots, and what those lots currently are. Facts an agent should never have had to infer.
 */
const argsSchema = z.object({
  /** Spliced by the loop — the caller's own address. Never model-supplied: an agent asking who
   * it is cannot be trusted to say who it is. */
  address: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export interface WhoamiLot {
  taskClass: string;
  classId: string;
  headroomMilliSiu: string;
  issuanceLimitMilliSiu: string;
}

export interface WhoamiResult {
  address: string;
  /** True when this address holds at least one bonded lot in any known class. */
  isIssuer: boolean;
  /** Every class this address has bonded capacity in, with its real current headroom. Empty for
   * a non-issuer — which is itself the answer to "am I an issuer". */
  lots: WhoamiLot[];
}

export const whoamiTool: ToolDefinition<Args, WhoamiResult> = {
  name: "whoami",
  argsSchema,
  async handler(ctx, args) {
    const address = args.address as Hex;
    const lots: WhoamiLot[] = [];

    for (const taskClass of KNOWN_TASK_CLASSES) {
      const classId = classIdFor(taskClass);
      const [headroom, issuanceLimit] = await Promise.all([
        ctx.deps.chainReader.headroom(address, classId),
        ctx.deps.chainReader.issuanceLimit(address, classId),
      ]);
      // A lot exists exactly when a real issuance limit was ever bonded for it — headroom alone
      // reads 0 both for "never bonded" and for "bonded and fully consumed", which are very
      // different facts to an issuer deciding what it can still sell.
      if (issuanceLimit > 0n) {
        lots.push({
          taskClass,
          classId,
          headroomMilliSiu: headroom.toString(),
          issuanceLimitMilliSiu: issuanceLimit.toString(),
        });
      }
    }

    return { address, isIssuer: lots.length > 0, lots };
  },
};
