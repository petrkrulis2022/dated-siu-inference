export type TaskClass = "code" | "extract";

/**
 * A gate is executable JS code — agent-authored (gate-market-spec.md §2.3: WORKER-EXTRACT writes
 * candidate gates), so it's a plain source string staged into the sandbox and executed there,
 * never eval'd in-process. Its source must export an async `gate(context)` function returning a
 * `GateVerdict`; `context` gives it `referenceDir`/`submissionDir` paths (already staged as files
 * inside the same sandbox run) rather than in-memory content, so it composes with real file-based
 * checks (running a pinned test suite, validating against a schema file) the same way whether the
 * check happens to be code or "just JSON" — see run-sandboxed.ts and gate/executor.ts's own doc
 * comments for why extract's gate spec goes through the identical boundary as code's.
 */
export interface GateSpec {
  taskClass: TaskClass;
  source: string;
}

/** Everything that fully describes "the reference task" as a gate needs to see it — for `code`:
 * the repo with the seeded bug plus the pinned node:test suite; for `extract`: the source
 * document plus the pinned JSON schema. Staged into the sandbox alongside the gate spec and the
 * submission being graded. Operator-supplied and trusted (spec §2.6) — never agent-authored. */
export interface ReferenceTaskInstance {
  taskClass: TaskClass;
  files: Record<string, string>;
}

/** What's being graded — a code patch, or an extraction JSON blob. Agent-authored, and per
 * gate-market-spec.md §2.3 explicitly adversarial when it comes from the class acting as
 * adversary, so it's never trusted. */
export interface Submission {
  files: Record<string, string>;
}

export interface GateVerdict {
  accept: boolean;
  reason: string;
}

/**
 * Every real attempt to run a gate ends in exactly one of these, and callers must not conflate
 * them (review, 2026-09-22 — the reason this type exists at all): a real bug found live where
 * three identical infra failures compared as "equal" and were reported as a deterministic
 * verdict, having never actually computed one.
 *
 * - `verdict`: the gate spec ran to completion and produced a real accept/reject. The only kind
 *   that may ever contribute to a "passed" result.
 * - `gate_error`: the gate spec itself is broken — syntax error, threw, no exported `gate()` —
 *   deterministically, reproducibly, regardless of host load. Counted as "did not accept" where
 *   that's the safe default (G2/G4), but never silently treated as a real verdict.
 * - `infra_failure`: the *harness* didn't finish the attempt — sandbox setup failed to start, a
 *   wall-clock timeout fired, or no readable result came back at all. Transient by nature (the
 *   same gate+submission run again, under less host load, would very likely resolve either other
 *   way) — retried automatically (see executor.ts's evaluateGateWithRetry) and, if still
 *   unresolved after retries, must make the check it belongs to fail explicitly rather than ever
 *   resolve to "passed".
 */
export type GateOutcome =
  | { kind: "verdict"; verdict: GateVerdict }
  | { kind: "gate_error"; error: string }
  | { kind: "infra_failure"; error: string };

export interface CheckResult {
  passed: boolean;
  reason: string;
  /** Set when `passed: false` is specifically because an infra_failure could not be resolved
   * after retries — never because a real verdict was computed. Distinguishes "the harness
   * couldn't tell" from "the gate genuinely failed this check", per review 2026-09-22. */
  infraFailure?: boolean;
}

/** The full input to one gate-hardening job's G1-G5 checks (spec §2.4). Note `originalGate` and
 * `hardenedGate` are deliberately separate: G1/G2/G3/G5 check the hardened gate, but G4 checks
 * the *original* candidate gate — proving the adversarial cases found something real against the
 * starting point, not a strawman rebuilt to make G4 trivially true. */
export interface GateHardeningJobInputs {
  taskClass: TaskClass;
  originalGate: GateSpec;
  hardenedGate: GateSpec;
  referenceInstance: ReferenceTaskInstance;
  knownGoodSubmission: Submission;
  adversarialSubmissions: Submission[];
}

export interface G1ToG5Result {
  g1: CheckResult;
  g2: CheckResult;
  g3: CheckResult;
  g4: CheckResult;
  g5: CheckResult;
  /** True only if every one of G1-G5 passed. */
  passed: boolean;
}
