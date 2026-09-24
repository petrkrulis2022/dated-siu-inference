export {
  evaluateGate,
  evaluateGateWithRetry,
  outcomesAgree,
  runGateHardeningChecks,
} from "./gate/index.js";
export type {
  TaskClass,
  GateSpec,
  ReferenceTaskInstance,
  Submission,
  GateVerdict,
  GateOutcome,
  CheckResult,
  GateHardeningJobInputs,
  GateHardeningResult,
  HeldOutInstance,
} from "./gate/index.js";

/** The real `code`/`extract` reference tasks built in WP-1 — exported from the package root so
 * WP-5's dry-loop scenarios (packages/gate-market-agents) can drive `submit_job` with genuine
 * fixtures instead of writing new, weaker duplicates. Same combination `code.test.ts`'s own "the
 * full G1-G5 pipeline" test already proves works end to end. */
export {
  COMMERCIAL_INTENT as CODE_COMMERCIAL_INTENT,
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_2_SINGLE_CASE,
  CODE_GATE_3_HARDENED,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_ADVERSARIAL_SHIPS_OWN_TESTS,
  CODE_HELD_OUT_INSTANCES,
  CODE_HASH_ANSWER_KEY_REGRESSION,
  CODE_SUBMISSION_CONTROLLED_TEST_REGRESSION,
  CODE_TESTS_FROM_SUBMISSION_DIR_REGRESSION,
  PINNED_TEST_SUITE,
} from "./gate/tasks/code.js";
export {
  COMMERCIAL_INTENT as EXTRACT_COMMERCIAL_INTENT,
  EXTRACT_REFERENCE,
  EXTRACT_KNOWN_GOOD,
  EXTRACT_GATE_1_TRIVIAL,
  EXTRACT_GATE_3_HARDENED,
  PLAUSIBLE_FABRICATION,
  NULL_SEMANTICS_ADVERSARIAL,
  FIELD_ORDER_GAMING,
  EXTRACT_HELD_OUT_INSTANCES,
  EXTRACT_ANSWER_KEY_REGRESSION,
  EXTRACT_LAYOUT_SPECIFIC_REGRESSION,
} from "./gate/tasks/extract.js";

/** WP-9: the `@touchstone/task-pack-sdk` `TaskPack` adapter — the bench loads this instead of
 * importing gate-hardening fixtures directly. The granular fixtures above stay exported too;
 * `packages/gate-market-agents/src/dry-loop/*` still composes them directly for its own scripted
 * (no-model) scenarios. */
export { CODE_GATE_HARDENING_PACK, EXTRACT_GATE_HARDENING_PACK } from "./pack.js";
export type { GateHardeningReference } from "./pack.js";
