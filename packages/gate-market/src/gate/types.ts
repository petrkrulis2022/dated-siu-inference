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

export interface CheckResult {
  passed: boolean;
  reason: string;
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
