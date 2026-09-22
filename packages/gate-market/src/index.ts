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
  G1ToG5Result,
} from "./gate/index.js";
