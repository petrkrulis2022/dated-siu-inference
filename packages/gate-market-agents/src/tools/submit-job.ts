import { z } from "zod";
import type { GateHardeningJobInputs, GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { ToolDefinition } from "./types.js";

const referenceInstanceSchema = z.object({
  taskClass: z.enum(["code", "extract"]),
  files: z.record(z.string(), z.string()),
});
const gateSpecSchema = z.object({ taskClass: z.enum(["code", "extract"]), source: z.string() });
const submissionSchema = z.object({ files: z.record(z.string(), z.string()) });
const heldOutInstanceSchema = z.object({
  referenceInstance: referenceInstanceSchema,
  knownGoodSubmission: submissionSchema,
  adversarialSubmissions: z.array(submissionSchema),
});

const argsSchema = z.object({
  taskClass: z.enum(["code", "extract"]),
  originalGate: gateSpecSchema,
  hardenedGate: gateSpecSchema,
  referenceInstance: referenceInstanceSchema,
  knownGoodSubmission: submissionSchema,
  adversarialSubmissions: z.array(submissionSchema),
  // G6 — required, minimum one: an empty held-out set would make generalization pass by
  // construction, exactly the gap it exists to close (see gate/types.ts's HeldOutInstance doc
  // comment upstream).
  heldOutInstances: z.array(heldOutInstanceSchema).min(1),
});

type Args = z.infer<typeof argsSchema>;

/**
 * Runs the G1-G6 gate-hardening checks via `@touchstone/task-pack-gate-hardening`'s
 * `runGateHardeningChecks` — injected through `deps.runGateHardeningChecks` (defaults to the
 * real sandboxed executor when wired by whatever constructs `RunnerDeps`) so this tool is
 * testable with no bubblewrap sandbox involved. No grading logic is reimplemented here.
 */
export const submitJobTool: ToolDefinition<Args, GateHardeningResult> = {
  name: "submit_job",
  argsSchema,
  async handler(ctx, args) {
    // zod's `.min(1)` already enforces "at least one held-out instance" at runtime — the domain
    // type's tuple shape exists for literal object construction (tests, the real CLI), not for
    // this network-shaped boundary, so the cast goes through `unknown` rather than widening the
    // domain type itself.
    return ctx.deps.runGateHardeningChecks(args as unknown as GateHardeningJobInputs);
  },
};
