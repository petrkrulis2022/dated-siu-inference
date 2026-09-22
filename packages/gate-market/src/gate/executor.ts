import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupScratch, runSandboxed } from "../sandbox/run-sandboxed.js";
import type {
  GateHardeningJobInputs,
  GateSpec,
  GateVerdict,
  G1ToG5Result,
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

interface GateEvaluation {
  ok: boolean;
  verdict?: GateVerdict;
  error?: string;
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

/** Runs one gate spec against one submission, inside the sandbox. Returns `ok: false` (never
 * throws for an agent-authored failure) whenever the gate spec itself misbehaves — fails to
 * parse, throws, times out, or is silently contained by the sandbox (network/env/fs attempts) —
 * since all of those are real, expected outcomes of running adversarial or simply broken
 * agent-authored code, not exceptional conditions in this harness. */
export async function evaluateGate(
  gateSpec: GateSpec,
  reference: ReferenceTaskInstance,
  submission: Submission,
): Promise<GateEvaluation> {
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
    return { ok: false, error: "gate execution timed out" };
  }

  try {
    const raw = await readFile(join(result.scratchDir, "verdict.json"), "utf-8");
    const parsed = JSON.parse(raw) as { error?: string; accept?: boolean; reason?: string };
    await cleanupScratch(result.scratchDir);
    if (parsed.error !== undefined) {
      return { ok: false, error: parsed.error };
    }
    return { ok: true, verdict: { accept: Boolean(parsed.accept), reason: parsed.reason ?? "" } };
  } catch (e) {
    await cleanupScratch(result.scratchDir);
    return {
      ok: false,
      error:
        `gate produced no readable verdict: ${String(e)}. ` +
        `stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`,
    };
  }
}

function allFail(reason: string): G1ToG5Result {
  const fail: CheckResult = { passed: false, reason };
  return { g1: fail, g2: fail, g3: fail, g4: fail, g5: fail, passed: false };
}

/** Sequential, not `Promise.all` — found live, 2026-09-22: running several evaluateGate calls
 * concurrently (each a real bash+bwrap+V8-boot subprocess tree) intermittently produced
 * empty-stdout / unexpected-timeout failures under real host load that never reproduced running
 * the same calls one at a time. Root cause not fully isolated (plausibly transient memory
 * pressure across several simultaneous V8 boots, each needing real resident memory beyond
 * RLIMIT_AS's virtual-space reservation) — rather than ship a race that's merely rare, checks
 * that decide whether a job gets paid run one evaluation at a time. Slower; correct. */
async function evaluateSequentially<T>(items: T[], fn: (item: T) => Promise<GateEvaluation>): Promise<GateEvaluation[]> {
  const results: GateEvaluation[] = [];
  for (const item of items) {
    results.push(await fn(item));
  }
  return results;
}

/**
 * gate-market-spec.md §2.4's five checks. Deliberately mechanical — no judgment calls, every
 * result traces to a real sandboxed execution. G1/G2/G3/G5 evaluate the *hardened* gate; G4
 * evaluates the *original* candidate gate — see types.ts's GateHardeningJobInputs doc comment for
 * why that split matters (G4 without it would be checking the adversary against a strawman).
 */
export async function runGateHardeningChecks(inputs: GateHardeningJobInputs): Promise<G1ToG5Result> {
  const g1Probe = await evaluateGate(inputs.hardenedGate, inputs.referenceInstance, inputs.knownGoodSubmission);
  if (!g1Probe.ok) {
    return allFail(`hardened gate did not execute (G1): ${g1Probe.error}`);
  }
  const g1: CheckResult = { passed: true, reason: "hardened gate parsed and executed" };

  // G3 falls out of the same probe call used for G1 — the known-good submission's verdict from
  // the hardened gate, no second evaluation needed.
  const g3: CheckResult = {
    passed: g1Probe.verdict!.accept,
    reason: g1Probe.verdict!.accept
      ? "known-good submission accepted by the hardened gate"
      : `known-good submission rejected by the hardened gate (over-tightening): ${g1Probe.verdict!.reason}`,
  };

  const g2Results = await evaluateSequentially(inputs.adversarialSubmissions, (s) =>
    evaluateGate(inputs.hardenedGate, inputs.referenceInstance, s),
  );
  const g2WronglyAccepted = g2Results.filter((r) => r.ok && r.verdict!.accept).length;
  const g2ExecutionFailures = g2Results.filter((r) => !r.ok).length;
  const g2: CheckResult = {
    passed: g2WronglyAccepted === 0 && g2ExecutionFailures === 0,
    reason:
      g2ExecutionFailures > 0
        ? `${g2ExecutionFailures}/${g2Results.length} adversarial case(s) failed to execute against the hardened gate`
        : g2WronglyAccepted > 0
          ? `${g2WronglyAccepted}/${g2Results.length} adversarial case(s) were incorrectly accepted by the hardened gate`
          : `all ${g2Results.length} adversarial case(s) correctly rejected by the hardened gate`,
  };

  const g4Results = await evaluateSequentially(inputs.adversarialSubmissions, (s) =>
    evaluateGate(inputs.originalGate, inputs.referenceInstance, s),
  );
  const g4PassedOriginal = g4Results.filter((r) => r.ok && r.verdict!.accept).length;
  const g4: CheckResult = {
    passed: g4PassedOriginal > 0,
    reason:
      g4PassedOriginal > 0
        ? `${g4PassedOriginal}/${g4Results.length} adversarial case(s) passed the original candidate gate`
        : "no adversarial case passed the original candidate gate — the job found nothing",
  };

  const g5Runs = await evaluateSequentially([0, 1, 2], () =>
    evaluateGate(inputs.hardenedGate, inputs.referenceInstance, inputs.knownGoodSubmission),
  );
  const g5Verdicts = g5Runs.map((r) => (r.ok ? r.verdict!.accept : "execution-failed"));
  const g5Consistent = g5Verdicts.every((v) => v === g5Verdicts[0]);
  const g5: CheckResult = {
    passed: g5Consistent,
    reason: g5Consistent
      ? "hardened gate executed deterministically across 3 runs"
      : `non-deterministic verdicts across 3 runs: ${JSON.stringify(g5Verdicts)}`,
  };

  return { g1, g2, g3, g4, g5, passed: g1.passed && g2.passed && g3.passed && g4.passed && g5.passed };
}
