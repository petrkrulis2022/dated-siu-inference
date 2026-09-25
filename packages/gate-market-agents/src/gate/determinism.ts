import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";

/** Deep-enough equality for a `GateHardeningResult` — same shape check by construction (both
 * results come from the same real function), so comparing every gate's `passed`/`reason` is the
 * real, checkable determinism property, not a proxy for it. Exported: `loop/full-run.ts` reuses
 * this directly when one of the two invocations being compared is already a recorded `Runner`
 * tool-call result rather than a second call `checkGateDeterminism`'s own thunk shape can produce. */
export function gateResultsMatch(a: GateHardeningResult, b: GateHardeningResult): boolean {
  if (a.passed !== b.passed) return false;
  const checks = ["g1", "g2", "g3", "g4", "g5", "g6"] as const;
  return checks.every((c) => a[c].passed === b[c].passed && a[c].reason === b[c].reason);
}

export interface DeterminismCheckResult {
  deterministic: boolean;
  first: GateHardeningResult;
  second: GateHardeningResult;
}

/**
 * Spec §9.3's "a gate becomes non-deterministic -> quarantine that gate, continue, record it."
 * Runs the same real G1-G6 executor twice, against identical inputs, within the same turn, and
 * compares — the only way to actually observe non-determinism rather than assume a deterministic
 * sandbox never produces it. Takes a thunk rather than the inputs directly so the caller controls
 * exactly which real invocation (`deps.runGateHardeningChecks`) gets called twice.
 */
export async function checkGateDeterminism(
  runOnce: () => Promise<GateHardeningResult>,
): Promise<DeterminismCheckResult> {
  const first = await runOnce();
  const second = await runOnce();
  return { deterministic: gateResultsMatch(first, second), first, second };
}
