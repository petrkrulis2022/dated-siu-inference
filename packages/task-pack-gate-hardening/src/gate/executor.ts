import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupScratch, runSandboxed } from "../sandbox/run-sandboxed.js";
import type {
  GateHardeningJobInputs,
  GateSpec,
  GateOutcome,
  GateHardeningResult,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  CheckResult,
} from "./types.js";

/**
 * Every gate evaluation — for `code` and `extract` alike — runs through the exact same
 * `runSandboxed` boundary the candidate-code path uses. A gate spec is agent-authored
 * (WORKER-EXTRACT writes it, spec §2.3), and `extract`'s gate is still real executable code that
 * runs against an agent-supplied submission — "it's just validating JSON" is not an exemption.
 * There is no in-process code path anywhere in this module; if the sandbox is unavailable,
 * `runSandboxed` itself throws (capability.ts) rather than this module silently falling back.
 */
const GATE_SANDBOX_DEFAULTS = {
  timeoutMs: 15000,
  // Same floor as the sandbox module's own tests: V8 needs ~512MB-1GB of virtual address space
  // reservation just to boot, independent of actual usage — see run-sandboxed.ts. Tried raising
  // this to 3GB live, 2026-09-22, to chase an intermittent local flake (below) — made it worse,
  // not better: V8 plausibly scales its upfront reservation attempt off the RLIMIT_AS ceiling
  // itself, so a larger cap can be *more* likely to fail under real memory pressure. Reverted.
  memoryLimitKb: 1572864,
  maxProcesses: 4096,
  maxHeapMb: 512,
} as const;

/** Retried up to this many extra times, infra_failure only — never on gate_error or a verdict
 * that just wasn't the one G4 was hoping for. 2 retries (3 attempts total) chosen to absorb a
 * genuinely transient hiccup without turning a real, reproducible infra outage into an unbounded
 * hang. */
const MAX_INFRA_RETRIES = 2;

/** Real, previously-observed stderr signatures of the harness itself failing to even start the
 * gate's process — found live, 2026-09-22, chasing local flakes this same session: bwrap's own
 * userns-contention message, and V8's boot-time OOM under a too-tight (or, found separately,
 * paradoxically too-loose) RLIMIT_AS. Matching on these is deliberately conservative — the point
 * isn't to catch every possible infra failure by pattern, it's to catch the ones already proven
 * real rather than guess at more. */
const INFRA_FAILURE_PATTERNS = [
  /Creating new namespace failed/,
  /Fatal process out of memory/,
  /Failed to reserve virtual memory/,
  /Resource temporarily unavailable/,
];

function looksLikeInfraFailure(text: string): boolean {
  return INFRA_FAILURE_PATTERNS.some((p) => p.test(text));
}

function buildEntryScript(): string {
  return [
    'import { writeFileSync } from "node:fs";',
    "try {",
    '  const mod = await import("./gate-spec.mjs");',
    '  if (typeof mod.gate !== "function") {',
    '    writeFileSync("/scratch/verdict.json", JSON.stringify({ error: "gate spec does not export a gate() function" }));',
    "  } else {",
    '    const verdict = await mod.gate({ referenceDir: "/scratch/reference", submissionDir: "/scratch/submission" });',
    "    writeFileSync(",
    '      "/scratch/verdict.json",',
    "      JSON.stringify({ accept: !!(verdict && verdict.accept), reason: String((verdict && verdict.reason) ?? \"\") }),",
    "    );",
    "  }",
    "} catch (e) {",
    '  writeFileSync("/scratch/verdict.json", JSON.stringify({ error: String((e && e.stack) || e) }));',
    "}",
  ].join("\n");
}

/**
 * Runs one gate spec against one submission, inside the sandbox, exactly once — no retry here
 * (see evaluateGateWithRetry for that). Classifies the result into GateOutcome's three kinds
 * rather than a bare ok/error pair: found live, 2026-09-22, that collapsing "the harness couldn't
 * finish" and "the gate computed a result" into the same shape let three identical infra failures
 * be read as a deterministic verdict, having never actually computed one.
 */
export async function evaluateGate(
  gateSpec: GateSpec,
  reference: ReferenceTaskInstance,
  submission: Submission,
): Promise<GateOutcome> {
  const files: Record<string, string> = {
    "entry.mjs": buildEntryScript(),
    "gate-spec.mjs": gateSpec.source,
  };
  for (const [path, content] of Object.entries(reference.files)) {
    files[`reference/${path}`] = content;
  }
  for (const [path, content] of Object.entries(submission.files)) {
    files[`submission/${path}`] = content;
  }

  const result = await runSandboxed({ ...GATE_SANDBOX_DEFAULTS, files, entry: "entry.mjs" });

  if (result.timedOut) {
    await cleanupScratch(result.scratchDir);
    // Deliberately infra_failure, not gate_error: a wall-clock timeout under load and a genuine
    // infinite loop in the gate's own logic are indistinguishable from here, and treating a
    // timeout as "the gate rejected" would make the verdict depend on how busy the host happens
    // to be — precisely the non-determinism this type exists to rule out.
    return { kind: "infra_failure", error: "gate execution timed out — could not confirm within the wall-clock limit" };
  }

  if (result.exitCode !== 0 && looksLikeInfraFailure(result.stderr)) {
    await cleanupScratch(result.scratchDir);
    return { kind: "infra_failure", error: `sandbox setup failed: ${result.stderr.slice(0, 300)}` };
  }

  try {
    const raw = await readFile(join(result.scratchDir, "verdict.json"), "utf-8");
    const parsed = JSON.parse(raw) as { error?: string; accept?: boolean; reason?: string };
    await cleanupScratch(result.scratchDir);
    if (parsed.error !== undefined) {
      return { kind: "gate_error", error: parsed.error };
    }
    return { kind: "verdict", verdict: { accept: Boolean(parsed.accept), reason: parsed.reason ?? "" } };
  } catch (e) {
    await cleanupScratch(result.scratchDir);
    // No parseable verdict and no matched infra signature: conservatively infra_failure rather
    // than guessed as gate_error. The entry script's own try/catch already covers every failure
    // path inside the gate spec itself and always writes *something* — the realistic ways to
    // reach here are the process being killed before it could write (memory pressure) or the
    // sandbox failing before node even started in a shape the patterns above didn't match. Either
    // way, retrying resolves a genuine transient; a truly deterministic failure here would simply
    // exhaust the retries and be reported honestly as an unresolved infra failure, never coerced
    // into a verdict either direction.
    return {
      kind: "infra_failure",
      error:
        `gate produced no readable verdict: ${String(e)}. ` +
        `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    };
  }
}

/** The only place infra_failure is ever retried — never a verdict or gate_error, which are both
 * deterministic properties of the (gate, submission) pair and retrying them would just be hoping
 * for a different answer. Returns the first non-infra_failure outcome, or the last infra_failure
 * if every attempt exhausts. */
export async function evaluateGateWithRetry(
  gateSpec: GateSpec,
  reference: ReferenceTaskInstance,
  submission: Submission,
): Promise<GateOutcome> {
  let last: GateOutcome = { kind: "infra_failure", error: "unreachable" };
  for (let attempt = 0; attempt <= MAX_INFRA_RETRIES; attempt++) {
    const outcome = await evaluateGate(gateSpec, reference, submission);
    if (outcome.kind !== "infra_failure") return outcome;
    last = outcome;
  }
  return last;
}

function allFail(reason: string, infraFailure = false): GateHardeningResult {
  const fail: CheckResult = { passed: false, reason, ...(infraFailure ? { infraFailure: true } : {}) };
  return { g1: fail, g2: fail, g3: fail, g4: fail, g5: fail, g6: fail, passed: false };
}

/** Sequential, not `Promise.all` — found live, 2026-09-22: running several evaluateGate calls
 * concurrently (each a real bash+bwrap+V8-boot subprocess tree) intermittently produced
 * empty-stdout / unexpected-timeout failures under real host load that never reproduced running
 * the same calls one at a time. Root cause not fully isolated (plausibly transient memory
 * pressure across several simultaneous V8 boots, each needing real resident memory beyond
 * RLIMIT_AS's virtual-space reservation) — rather than ship a race that's merely rare, checks
 * that decide whether a job gets paid run one evaluation at a time. Slower; correct. */
async function evaluateSequentially<T>(
  items: T[],
  fn: (item: T) => Promise<GateOutcome>,
): Promise<GateOutcome[]> {
  const results: GateOutcome[] = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
}

/** True only if `outcome` is an accepted verdict — the one thing G2/G4 ever treat as "this
 * submission got through". A gate_error (the gate itself is broken on this input) is *not*
 * acceptance — an erroring gate never mistakenly pays an adversary — and is reported distinctly
 * in the reason text below rather than silently folded into "correctly rejected". */
function wasAccepted(outcome: GateOutcome): boolean {
  return outcome.kind === "verdict" && outcome.verdict.accept;
}

/**
 * Pure, and exported specifically so it can be unit-tested without touching the sandbox at all —
 * review, 2026-09-22: the previous test for "G5 catches real non-determinism" used a genuinely
 * random gate as its fixture, which meant the test itself had a real, disclosed ~25% chance of a
 * false negative per run. That was defensible as long as it only proved the *comparison* logic,
 * but the comparison logic is exactly what belongs in a pure function testable with fixed,
 * deterministic inputs instead. Two outcomes "agree" if both are verdicts with the same
 * `accept`, or both are gate_error (a gate that deterministically breaks on this input every
 * time is, in that narrow sense, still behaving consistently) — never if either is unresolved.
 */
export function outcomesAgree(outcomes: (GateOutcome & { kind: "verdict" | "gate_error" })[]): boolean {
  if (outcomes.length === 0) return true;
  const key = (o: (typeof outcomes)[number]) => (o.kind === "verdict" ? `verdict:${o.verdict.accept}` : "gate_error");
  const first = key(outcomes[0]);
  return outcomes.every((o) => key(o) === first);
}

/**
 * G6 — generalization (found live, 2026-09-23, not speculated): a gate can pass G1-G5 by
 * embedding the *one* reference instance's expected values as literals, never reading
 * `referenceDir` at runtime. G1-G5 never vary the reference instance, so that strategy is
 * invisible to them. This evaluates the hardened gate against a reference instance it was never
 * authored against — its own known-good must be accepted, every one of its own adversarial
 * submissions must be rejected. Sequential, not `Promise.all` — same reasoning as
 * `evaluateSequentially` above (concurrent sandboxed evaluations proved unreliable under real
 * host load); not reused directly since its return type is pinned to `GateOutcome`, not this
 * check's own richer per-instance result.
 */
async function evaluateHeldOutInstance(
  hardenedGate: GateSpec,
  instance: HeldOutInstance,
  evaluate: typeof evaluateGateWithRetry,
): Promise<{ passed: boolean; infraFailure: boolean; reason: string }> {
  const goodOutcome = await evaluate(hardenedGate, instance.referenceInstance, instance.knownGoodSubmission);
  if (goodOutcome.kind === "infra_failure") {
    return {
      passed: false,
      infraFailure: true,
      reason: "held-out known-good could not be evaluated after retries — infrastructure failure, not a verdict",
    };
  }
  if (!wasAccepted(goodOutcome)) {
    return {
      passed: false,
      infraFailure: false,
      reason: "held-out known-good was rejected — the gate does not generalize to this held-out instance",
    };
  }

  const adversarialResults: GateOutcome[] = [];
  for (const submission of instance.adversarialSubmissions) {
    adversarialResults.push(await evaluate(hardenedGate, instance.referenceInstance, submission));
  }
  const infraFailures = adversarialResults.filter((r) => r.kind === "infra_failure").length;
  if (infraFailures > 0) {
    return {
      passed: false,
      infraFailure: true,
      reason: `${infraFailures}/${adversarialResults.length} held-out adversarial case(s) could not be evaluated after retries — infrastructure failure, not a verdict`,
    };
  }
  const wronglyAccepted = adversarialResults.filter(wasAccepted).length;
  if (wronglyAccepted > 0) {
    return {
      passed: false,
      infraFailure: false,
      reason: `${wronglyAccepted}/${adversarialResults.length} held-out adversarial case(s) were incorrectly accepted — the gate does not generalize`,
    };
  }
  return { passed: true, infraFailure: false, reason: "held-out instance passed" };
}

/**
 * gate-market-spec.md §2.4's five checks, plus G6 (generalization — see `HeldOutInstance`'s own
 * doc comment in types.ts for why it exists). Deliberately mechanical — no judgment calls, every
 * result traces to a real sandboxed execution. G1/G2/G3/G5/G6 evaluate the *hardened* gate; G4
 * evaluates the *original* candidate gate — see types.ts's GateHardeningJobInputs doc comment for
 * why that split matters (G4 without it would be checking the adversary against a strawman).
 *
 * `evaluate` is injectable, defaulting to the real `evaluateGateWithRetry` — same pattern as
 * `packages/agents/src/seller.ts`'s `SellerDeps`. Added specifically so G5's own control flow
 * (does it correctly flag disagreement, does it correctly refuse to call unresolved infra
 * failures "deterministic") can be tested with fixed, controlled outcome sequences rather than a
 * real random gate, which is what the previous version of this test suite did and which carried
 * a genuine, disclosed ~25% chance of a false negative per run (see git history, 2026-09-22).
 * `evaluateGate`/`evaluateGateWithRetry` themselves are unchanged and still exercised for real by
 * every other test in this file and by code.test.ts/extract.test.ts's full pipelines.
 */
export async function runGateHardeningChecks(
  inputs: GateHardeningJobInputs,
  evaluate: typeof evaluateGateWithRetry = evaluateGateWithRetry,
): Promise<GateHardeningResult> {
  const g1Outcome = await evaluate(inputs.hardenedGate, inputs.referenceInstance, inputs.knownGoodSubmission);
  if (g1Outcome.kind === "infra_failure") {
    return allFail(
      `could not evaluate the hardened gate after ${MAX_INFRA_RETRIES + 1} attempts — infrastructure failure, no verdict was ever computed: ${g1Outcome.error}`,
      true,
    );
  }
  if (g1Outcome.kind === "gate_error") {
    return allFail(`hardened gate did not execute (G1): ${g1Outcome.error}`);
  }
  const g1: CheckResult = { passed: true, reason: "hardened gate parsed and executed" };

  // G3 falls out of the same probe call used for G1 — the known-good submission's verdict from
  // the hardened gate, no second evaluation needed.
  const g3: CheckResult = {
    passed: g1Outcome.verdict.accept,
    reason: g1Outcome.verdict.accept
      ? "known-good submission accepted by the hardened gate"
      : `known-good submission rejected by the hardened gate (over-tightening): ${g1Outcome.verdict.reason}`,
  };

  const g2Results = await evaluateSequentially(inputs.adversarialSubmissions, (s) =>
    evaluate(inputs.hardenedGate, inputs.referenceInstance, s),
  );
  const g2InfraFailures = g2Results.filter((r) => r.kind === "infra_failure").length;
  const g2WronglyAccepted = g2Results.filter(wasAccepted).length;
  const g2: CheckResult = {
    passed: g2InfraFailures === 0 && g2WronglyAccepted === 0,
    infraFailure: g2InfraFailures > 0,
    reason:
      g2InfraFailures > 0
        ? `${g2InfraFailures}/${g2Results.length} adversarial case(s) could not be evaluated against the hardened gate after retries — infrastructure failure, not a verdict`
        : g2WronglyAccepted > 0
          ? `${g2WronglyAccepted}/${g2Results.length} adversarial case(s) were incorrectly accepted by the hardened gate`
          : `all ${g2Results.length} adversarial case(s) correctly rejected by the hardened gate`,
  };

  const g4Results = await evaluateSequentially(inputs.adversarialSubmissions, (s) =>
    evaluate(inputs.originalGate, inputs.referenceInstance, s),
  );
  const g4InfraFailures = g4Results.filter((r) => r.kind === "infra_failure").length;
  const g4PassedOriginal = g4Results.filter(wasAccepted).length;
  const g4: CheckResult = {
    passed: g4InfraFailures === 0 && g4PassedOriginal > 0,
    infraFailure: g4InfraFailures > 0,
    reason:
      g4InfraFailures > 0
        ? `${g4InfraFailures}/${g4Results.length} adversarial case(s) could not be evaluated against the original gate after retries — infrastructure failure, not a verdict`
        : g4PassedOriginal > 0
          ? `${g4PassedOriginal}/${g4Results.length} adversarial case(s) passed the original candidate gate`
          : "no adversarial case passed the original candidate gate — the job found nothing",
  };

  const g5Runs = await evaluateSequentially([0, 1, 2], () =>
    evaluate(inputs.hardenedGate, inputs.referenceInstance, inputs.knownGoodSubmission),
  );
  const g5InfraFailures = g5Runs.filter((r) => r.kind === "infra_failure").length;
  const g5: CheckResult =
    g5InfraFailures > 0
      ? {
          passed: false,
          infraFailure: true,
          reason: `${g5InfraFailures}/3 determinism-check run(s) could not be evaluated after retries — infrastructure failure, determinism not confirmed`,
        }
      : (() => {
          const resolved = g5Runs as (GateOutcome & { kind: "verdict" | "gate_error" })[];
          const consistent = outcomesAgree(resolved);
          return {
            passed: consistent,
            reason: consistent
              ? "hardened gate executed deterministically across 3 runs"
              : `non-deterministic verdicts across 3 runs: ${JSON.stringify(resolved)}`,
          };
        })();

  const heldOutResults: { passed: boolean; infraFailure: boolean; reason: string }[] = [];
  for (const instance of inputs.heldOutInstances) {
    heldOutResults.push(await evaluateHeldOutInstance(inputs.hardenedGate, instance, evaluate));
  }
  const g6InfraFailures = heldOutResults.filter((r) => r.infraFailure).length;
  const g6Failed = heldOutResults.filter((r) => !r.passed && !r.infraFailure);
  const g6: CheckResult = {
    passed: g6InfraFailures === 0 && g6Failed.length === 0,
    infraFailure: g6InfraFailures > 0,
    reason:
      g6InfraFailures > 0
        ? `${g6InfraFailures}/${heldOutResults.length} held-out instance(s) could not be evaluated after retries — infrastructure failure, not a verdict`
        : g6Failed.length > 0
          ? `${g6Failed.length}/${heldOutResults.length} held-out instance(s) failed to generalize: ${g6Failed.map((r) => r.reason).join("; ")}`
          : `hardened gate generalized correctly across all ${heldOutResults.length} held-out instance(s)`,
  };

  return {
    g1,
    g2,
    g3,
    g4,
    g5,
    g6,
    passed: g1.passed && g2.passed && g3.passed && g4.passed && g5.passed && g6.passed,
  };
}
