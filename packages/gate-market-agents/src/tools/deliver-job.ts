import { z } from "zod";
import type { ToolDefinition } from "./types.js";

/**
 * `deliver_job` — the currency lab's seller step: spend one unit of raw work and deliver a job that has
 * been paid for, with the seller's own skill. The work is done and graded by the harness's work
 * executor (`lab/jobs.ts`), never by an agent writing anything; the grader's verdict decides whether
 * the buyer's need is met.
 *
 * The job's instance, and its expected answer, live in the lab's service. This tool passes only the
 * request id, so nothing an agent can read — its arguments, its result, its history — carries the
 * answer. All of the rules (who may deliver what, the unit of raw work, how many attempts) are the
 * service's, and it refuses in sentences that say only what is so.
 */
const argsSchema = z.object({
  /** The request whose quote was paid: the board's id, e.g. "qr-3". */
  requestId: z.string(),
});

type Args = z.infer<typeof argsSchema>;

export const deliverJobTool: ToolDefinition<Args, unknown> = {
  name: "deliver_job",
  argsSchema,
  async handler(ctx, args) {
    if (ctx.deps.lab === undefined) {
      throw new Error("deliver_job: this run has no jobs to deliver.");
    }
    return ctx.deps.lab.deliverJob(ctx.agentId, args.requestId);
  },
};
