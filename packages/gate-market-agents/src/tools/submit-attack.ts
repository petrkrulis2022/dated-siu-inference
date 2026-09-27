import { z } from "zod";
import {
  evaluateGate,
  runCodeOracle,
  scoreAttack,
  type GateSpec,
  type ReferenceTaskInstance,
} from "@touchstone/task-pack-gate-hardening";
import type { ToolDefinition } from "./types.js";

/**
 * `submit_attack` — the adversary's real action against a delivered gate (spec §3, where each
 * worker's written goal includes acting as adversary on the other class's jobs, and §3.1, which
 * scores a worker on "adversarial yield: how many of its attacks defeated a candidate gate").
 *
 * Before this existed, a gate only ever faced the fixed candidate submissions shipped in the task
 * pack, so a run could not produce the one artefact the experiment is meant to keep: a hardened
 * gate with a measured false-accept rate against submissions an agent actually wrote.
 *
 * The model supplies `submissionSource` and nothing else. The target gate, the reference instance
 * and the oracle seed are spliced in by the loop (`buildToolArgs`), the same way `submit_job`'s
 * job inputs already are — an adversary must not get to choose which gate it is scored against or
 * which trials the oracle uses.
 *
 * Scoring never rests on the gate's verdict alone: a submission is only a hit when the gate
 * accepts something the independent oracle rejects. See `code-oracle.ts` for why a hostile
 * submission cannot profitably corrupt that oracle, and `attack-scoring.ts` for the full matrix.
 */
const argsSchema = z.object({
  /** Agent-authored and hostile by definition — runs only in the sandbox, never in-process. */
  submissionSource: z.string(),
  targetGateSource: z.string(),
  taskClass: z.enum(["code", "extract"]),
  referenceFiles: z.record(z.string(), z.string()),
  /** Recorded with every attack so the exact trial set is reproducible from the run log. */
  oracleSeed: z.number().int(),
  /** Which revision of the gate this attack was aimed at — 1 for the first delivered gate. */
  gateVersion: z.number().int(),
});

type Args = z.infer<typeof argsSchema>;

export interface AttackToolResult {
  classification: string;
  reason: string;
  countsAsAdversaryYield: boolean;
  countsAsGateOverRejection: boolean;
  gateVersion: number;
  oracleSeed: number;
  gate: { kind: string; accept?: boolean; reason?: string; error?: string };
  oracle: { kind: string; accept?: boolean; reason?: string; trialsRun?: number; error?: string };
}

export const submitAttackTool: ToolDefinition<Args, AttackToolResult> = {
  name: "submit_attack",
  argsSchema,
  async handler(_ctx, args) {
    const gateSpec: GateSpec = { taskClass: args.taskClass, source: args.targetGateSource };
    const reference: ReferenceTaskInstance = {
      taskClass: args.taskClass,
      files: args.referenceFiles,
    };
    const submission = { files: { "answer.mjs": args.submissionSource } };

    // Deliberately sequential: both run real sandboxes, and running them together under the same
    // process limits is how a genuinely heavy submission turns one honest verdict into two
    // infra failures.
    const gateOutcome = await evaluateGate(gateSpec, reference, submission);
    const oracleOutcome = await runCodeOracle(submission, { seed: args.oracleSeed });
    const score = scoreAttack(gateOutcome, oracleOutcome);

    return {
      classification: score.classification,
      reason: score.reason,
      countsAsAdversaryYield: score.countsAsAdversaryYield,
      countsAsGateOverRejection: score.countsAsGateOverRejection,
      gateVersion: args.gateVersion,
      oracleSeed: args.oracleSeed,
      gate:
        gateOutcome.kind === "verdict"
          ? { kind: gateOutcome.kind, accept: gateOutcome.verdict.accept, reason: gateOutcome.verdict.reason }
          : { kind: gateOutcome.kind, error: gateOutcome.error },
      oracle:
        oracleOutcome.kind === "verdict"
          ? {
              kind: oracleOutcome.kind,
              accept: oracleOutcome.accept,
              reason: oracleOutcome.reason,
              trialsRun: oracleOutcome.trialsRun,
            }
          : { kind: oracleOutcome.kind, error: oracleOutcome.error },
    };
  },
};
