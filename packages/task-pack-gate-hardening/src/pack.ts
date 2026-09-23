import type { GateResult, TaskPack } from "@touchstone/task-pack-sdk";
import { runGateHardeningChecks } from "./gate/executor.js";
import type {
  GateHardeningResult,
  GateSpec,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  TaskClass,
} from "./gate/types.js";
import {
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_STUBBED,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_2_SINGLE_CASE,
  CODE_GATE_3_HARDENED,
  CODE_HELD_OUT_INSTANCES,
  CODE_KNOWN_GOOD,
  CODE_REFERENCE,
} from "./gate/tasks/code.js";
import {
  EXTRACT_GATE_1_TRIVIAL,
  EXTRACT_GATE_2_TEXT_SCAN,
  EXTRACT_GATE_3_HARDENED,
  EXTRACT_HELD_OUT_INSTANCES,
  EXTRACT_KNOWN_GOOD,
  EXTRACT_REFERENCE,
  FIELD_ORDER_GAMING,
  NULL_SEMANTICS_ADVERSARIAL,
  PLAUSIBLE_FABRICATION,
} from "./gate/tasks/extract.js";

/**
 * `@touchstone/task-pack-sdk`'s `gate(submission, reference)` is deliberately generic — this
 * pack's real "submission being graded" is a candidate *gate* an agent wrote (spec §2.3:
 * WORKER-EXTRACT authors it), not a plain answer file. `reference` is therefore everything
 * `runGateHardeningChecks` needs besides the candidate itself: the original (deliberately weak)
 * starting gate G4 checks the adversarial cases against, the reference task instance, the known-
 * good submission, and the adversarial submissions used to probe both gates.
 */
export interface GateHardeningReference {
  taskClass: TaskClass;
  originalGate: GateSpec;
  referenceInstance: ReferenceTaskInstance;
  knownGoodSubmission: Submission;
  adversarialSubmissions: Submission[];
  heldOutInstances: readonly [HeldOutInstance, ...HeldOutInstance[]];
}

function summarize(result: GateHardeningResult): string {
  if (result.passed) return "G1-G6 all passed";
  const checks = [
    ["G1", result.g1],
    ["G2", result.g2],
    ["G3", result.g3],
    ["G4", result.g4],
    ["G5", result.g5],
    ["G6", result.g6],
  ] as const;
  const failed = checks.filter(([, check]) => !check.passed);
  return failed.map(([name, check]) => `${name} failed: ${check.reason}`).join("; ");
}

async function gateHardeningGate(
  submission: GateSpec,
  reference: GateHardeningReference,
): Promise<GateResult> {
  const result = await runGateHardeningChecks({
    taskClass: reference.taskClass,
    originalGate: reference.originalGate,
    hardenedGate: submission,
    referenceInstance: reference.referenceInstance,
    knownGoodSubmission: reference.knownGoodSubmission,
    adversarialSubmissions: reference.adversarialSubmissions,
    heldOutInstances: reference.heldOutInstances,
  });
  return { accept: result.passed, reason: summarize(result) };
}

interface BuildArgs {
  taskClass: TaskClass;
  workUnit: string;
  originalGate: GateSpec;
  hardenedGate: GateSpec;
  weakCandidateGate: GateSpec;
  referenceInstance: ReferenceTaskInstance;
  knownGoodSubmission: Submission;
  adversarialSubmissions: Submission[];
  heldOutInstances: readonly [HeldOutInstance, ...HeldOutInstance[]];
}

/**
 * `fixtures.knownGood`/`fixtures.adversarial` are pack-level fixtures — a *submitted gate* that
 * a correct `gate()` implementation must accept vs. reject — one level up from
 * `runGateHardeningChecks`'s own internal G2/G4 adversarial-submission checks, which probe
 * whether a given gate correctly rejects bad *code*. Don't conflate the two: this pack's
 * `fixtures.adversarial` is `[weakCandidateGate]` (a gate the executor should reject), not the
 * code/extraction submissions used inside the executor's own G2/G4 checks.
 */
function buildGateHardeningPack(args: BuildArgs): TaskPack<GateSpec, GateHardeningReference> {
  const reference: GateHardeningReference = {
    taskClass: args.taskClass,
    originalGate: args.originalGate,
    referenceInstance: args.referenceInstance,
    knownGoodSubmission: args.knownGoodSubmission,
    adversarialSubmissions: args.adversarialSubmissions,
    heldOutInstances: args.heldOutInstances,
  };
  return {
    name: `gate-hardening/${args.taskClass}`,
    roles: ["WORKER-CODE", "WORKER-EXTRACT"],
    workUnit: args.workUnit,
    gate: gateHardeningGate,
    fixtures: {
      reference,
      knownGood: args.hardenedGate,
      adversarial: [args.weakCandidateGate],
    },
    metrics: ["g1_pass_rate", "g2_pass_rate", "g3_pass_rate", "g4_pass_rate", "g5_pass_rate", "false_accept_rate"],
  };
}

export const CODE_GATE_HARDENING_PACK: TaskPack<GateSpec, GateHardeningReference> = buildGateHardeningPack({
  taskClass: "code",
  workUnit: "Harden a candidate gate against the `code` reference task (repair a seeded bug in a sorted-array dedupe function, pinned node:test suite).",
  originalGate: CODE_GATE_1_TRIVIAL,
  hardenedGate: CODE_GATE_3_HARDENED,
  weakCandidateGate: CODE_GATE_2_SINGLE_CASE,
  referenceInstance: CODE_REFERENCE,
  knownGoodSubmission: CODE_KNOWN_GOOD,
  adversarialSubmissions: [
    CODE_ADVERSARIAL_ORIGINAL_BUG,
    CODE_ADVERSARIAL_HARDCODED,
    CODE_ADVERSARIAL_STUBBED,
    CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  ],
  heldOutInstances: CODE_HELD_OUT_INSTANCES,
});

export const EXTRACT_GATE_HARDENING_PACK: TaskPack<GateSpec, GateHardeningReference> = buildGateHardeningPack({
  taskClass: "extract",
  workUnit: "Harden a candidate gate against the `extract` reference task (validate a structured extraction of an invoice document against a pinned JSON schema).",
  originalGate: EXTRACT_GATE_1_TRIVIAL,
  hardenedGate: EXTRACT_GATE_3_HARDENED,
  weakCandidateGate: EXTRACT_GATE_2_TEXT_SCAN,
  referenceInstance: EXTRACT_REFERENCE,
  knownGoodSubmission: EXTRACT_KNOWN_GOOD,
  adversarialSubmissions: [PLAUSIBLE_FABRICATION, NULL_SEMANTICS_ADVERSARIAL, FIELD_ORDER_GAMING],
  heldOutInstances: EXTRACT_HELD_OUT_INSTANCES,
});
