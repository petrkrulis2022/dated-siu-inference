import { z } from "zod";
import type { GateHardeningJobInputs, G1ToG5Result } from "@touchstone/gate-market";
import type { ToolDefinition } from "./types.js";

const gateSpecSchema = z.object({ taskClass: z.enum(["code", "extract"]), source: z.string() });
const submissionSchema = z.object({ files: z.record(z.string(), z.string()) });

const argsSchema = z.object({
  taskClass: z.enum(["code", "extract"]),
  originalGate: gateSpecSchema,
  hardenedGate: gateSpecSchema,
  referenceInstance: z.object({
    taskClass: z.enum(["code", "extract"]),
    files: z.record(z.string(), z.string()),
  }),
  knownGoodSubmission: submissionSchema,
  adversarialSubmissions: z.array(submissionSchema),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Runs the G1-G5 gate-hardening checks via `@touchstone/gate-market`'s
 * `runGateHardeningChecks` — injected through `deps.runGateHardeningChecks` (defaults to the
 * real sandboxed executor when wired by whatever constructs `RunnerDeps`) so this tool is
 * testable with no bubblewrap sandbox involved. No grading logic is reimplemented here.
 */
export const submitJobTool: ToolDefinition<Args, G1ToG5Result> = {
  name: "submit_job",
  argsSchema,
  async handler(ctx, args) {
    return ctx.deps.runGateHardeningChecks(args as GateHardeningJobInputs);
  },
};
