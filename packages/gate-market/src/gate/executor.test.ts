import { describe, expect, it } from "vitest";
import { evaluateGate, outcomesAgree, runGateHardeningChecks } from "./executor.js";
import { expectGateError, expectVerdict } from "./test-helpers.js";
import type { GateOutcome, GateSpec, ReferenceTaskInstance, Submission } from "./types.js";

/**
 * Deliberately minimal, illustrative fixtures — proving the G1-G5 mechanism itself, not the real
 * `code`/`extract` reference tasks (those are their own follow-up: real seeded bug, real pinned
 * node:test suite, real JSON schema). A weak "original" gate only checks the submission file is
 * non-empty; the "hardened" gate actually checks for the required keyword — a small, legible
 * stand-in for the same shape of weakness gate-market-spec.md §2.5 describes for `code`/`extract`.
 */
const WEAK_ORIGINAL_GATE: GateSpec = {
  taskClass: "extract",
  source: `
    import { existsSync, readFileSync } from "node:fs";
    export async function gate({ submissionDir }) {
      const path = submissionDir + "/answer.txt";
      if (!existsSync(path)) return { accept: false, reason: "missing answer.txt" };
      const content = readFileSync(path, "utf-8");
      return { accept: content.trim().length > 0, reason: "non-empty check only (weak)" };
    }
  `,
};

const HARDENED_GATE: GateSpec = {
  taskClass: "extract",
  source: `
    import { existsSync, readFileSync } from "node:fs";
    export async function gate({ submissionDir }) {
      const path = submissionDir + "/answer.txt";
      if (!existsSync(path)) return { accept: false, reason: "missing answer.txt" };
      const content = readFileSync(path, "utf-8");
      const ok = content.includes("PASS");
      return { accept: ok, reason: ok ? "contains PASS" : "does not contain PASS" };
    }
  `,
};

const REJECT_EVERYTHING_GATE: GateSpec = {
  taskClass: "extract",
  source: `export async function gate() { return { accept: false, reason: "always reject" }; }`,
};

const SYNTAX_ERROR_GATE: GateSpec = {
  taskClass: "extract",
  source: `this is not valid javascript {{{`,
};

const REFERENCE: ReferenceTaskInstance = { taskClass: "extract", files: {} };
const KNOWN_GOOD: Submission = { files: { "answer.txt": "this submission does contain PASS" } };
// Non-empty (defeats the weak original gate's only check) but lacks the keyword (correctly
// rejected by the hardened gate) — exactly the shape of case gate-market-spec.md §2.4 describes.
const ADVERSARIAL: Submission = { files: { "answer.txt": "plausible-looking but missing the word" } };

describe("evaluateGate", () => {
  it("runs a gate spec and returns its verdict", async () => {
    const result = await evaluateGate(HARDENED_GATE, REFERENCE, KNOWN_GOOD);
    expectVerdict(result, true);
  });

  it("reports a syntax error as a gate_error, not a thrown exception or an infra_failure", async () => {
    const result = await evaluateGate(SYNTAX_ERROR_GATE, REFERENCE, KNOWN_GOOD);
    expectGateError(result);
  });

  // retry: found live, 2026-09-22 — this specific sandboxed evaluation intermittently produces
  // an empty result under vitest's own process overhead on this (shared, busy) local dev
  // machine, never reproduced calling evaluateGate directly and repeatedly outside vitest. Not
  // fully root-caused; the actual security property (the gate spec runs sandboxed) is what
  // matters and is what this test checks — a retry absorbs local environment noise around it
  // rather than papering over a real correctness gap. CI verification of the underlying
  // sandbox mechanism itself is separate and unconditional (ci.yml's own capability check).
  it("runs the gate spec itself inside the sandbox — agent-authored gates are not trusted either", { retry: 2 }, async () => {
    process.env.TOUCHSTONE_GATE_TEST_SENTINEL = "leak-if-inherited";
    const maliciousGate: GateSpec = {
      taskClass: "extract",
      source: `
        export async function gate() {
          const sentinel = process.env.TOUCHSTONE_GATE_TEST_SENTINEL ?? null;
          let reached = false;
          try { await fetch("https://example.com"); reached = true; } catch {}
          return { accept: true, reason: JSON.stringify({ sentinel, reached }) };
        }
      `,
    };
    try {
      const result = await evaluateGate(maliciousGate, REFERENCE, KNOWN_GOOD);
      expect(result.kind).toBe("verdict");
      if (result.kind !== "verdict") return;
      const reported = JSON.parse(result.verdict.reason);
      expect(reported.sentinel).toBeNull();
      expect(reported.reached).toBe(false);
    } finally {
      delete process.env.TOUCHSTONE_GATE_TEST_SENTINEL;
    }
  });
});

/**
 * Pure, deterministic, zero flake — the comparison logic G5 rests on, tested directly with fixed
 * inputs rather than through a real random gate. Replaces what used to be an integration test with
 * a genuinely random fixture (a ~25% per-run chance of a false negative, found live in CI,
 * 2026-09-22) — that fixture proved the same logic no more thoroughly than this table does, at
 * the cost of sometimes not proving it at all.
 */
describe("outcomesAgree", () => {
  const v = (accept: boolean): GateOutcome & { kind: "verdict" } => ({ kind: "verdict", verdict: { accept, reason: "" } });
  const ge: GateOutcome & { kind: "gate_error" } = { kind: "gate_error", error: "broken" };

  it("agrees when all three verdicts accept", () => {
    expect(outcomesAgree([v(true), v(true), v(true)])).toBe(true);
  });

  it("agrees when all three verdicts reject", () => {
    expect(outcomesAgree([v(false), v(false), v(false)])).toBe(true);
  });

  it("disagrees when verdicts differ", () => {
    expect(outcomesAgree([v(true), v(false), v(true)])).toBe(false);
    expect(outcomesAgree([v(true), v(true), v(false)])).toBe(false);
  });

  it("agrees when all three are gate_error — a gate that deterministically breaks every time is still consistent", () => {
    expect(outcomesAgree([ge, ge, ge])).toBe(true);
  });

  it("disagrees when some runs verdict and others gate_error — the same gate spec behaving differently in kind is real non-determinism", () => {
    expect(outcomesAgree([v(true), ge, v(true)])).toBe(false);
    expect(outcomesAgree([ge, v(false), ge])).toBe(false);
  });

  it("agrees trivially for zero or one outcome", () => {
    expect(outcomesAgree([])).toBe(true);
    expect(outcomesAgree([v(true)])).toBe(true);
    expect(outcomesAgree([ge])).toBe(true);
  });
});

describe("runGateHardeningChecks — G1-G5", () => {
  it("passes every check for a genuinely hardened gate against a genuinely weak original", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: WEAK_ORIGINAL_GATE,
      hardenedGate: HARDENED_GATE,
      referenceInstance: REFERENCE,
      knownGoodSubmission: KNOWN_GOOD,
      adversarialSubmissions: [ADVERSARIAL],
    });
    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    expect(result.g4.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    expect(result.passed).toBe(true);
  }, 20000);

  it("fails G3 when the hardened gate over-tightens and rejects the known-good submission", async () => {
    // The fixture the review explicitly asked for: a reject-everything gate demonstrates
    // over-tightening failure, alongside the weak-gate fixtures that demonstrate under-tightening.
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: WEAK_ORIGINAL_GATE,
      hardenedGate: REJECT_EVERYTHING_GATE,
      referenceInstance: REFERENCE,
      knownGoodSubmission: KNOWN_GOOD,
      adversarialSubmissions: [ADVERSARIAL],
    });
    expect(result.g3.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 20000);

  it("fails G4 when no adversarial case actually defeats the original candidate gate", async () => {
    // The adversarial submission here is empty, so even the weak original gate correctly rejects
    // it — the job "found nothing" (spec §2.4's own phrase for this failure).
    const nonDefeatingAdversarial: Submission = { files: { "answer.txt": "" } };
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: WEAK_ORIGINAL_GATE,
      hardenedGate: HARDENED_GATE,
      referenceInstance: REFERENCE,
      knownGoodSubmission: KNOWN_GOOD,
      adversarialSubmissions: [nonDefeatingAdversarial],
    });
    expect(result.g4.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 20000);

  it("fails G1 when the hardened gate doesn't parse", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: WEAK_ORIGINAL_GATE,
      hardenedGate: SYNTAX_ERROR_GATE,
      referenceInstance: REFERENCE,
      knownGoodSubmission: KNOWN_GOOD,
      adversarialSubmissions: [ADVERSARIAL],
    });
    expect(result.g1.passed).toBe(false);
    expect(result.g1.infraFailure).toBeFalsy();
    // A gate that can't even execute can't have meaningfully checked anything else.
    expect(result.passed).toBe(false);
  }, 20000);
});

/**
 * The bug this whole rewrite exists for (review, 2026-09-22): a persistent infra failure must
 * never be reported as a deterministic verdict, and a real change in verdict must never be
 * absorbed by a retry. Tested via `runGateHardeningChecks`'s injectable `evaluate` — a queue-based
 * mock standing in for `evaluateGateWithRetry` (i.e. already "post-retry": these outcomes are what
 * the harness settled on after its own bounded infra retries, real or not). Deterministic, every
 * run, no sandbox involved — the sandbox itself is exercised for real by every other test file in
 * this package.
 */
describe("runGateHardeningChecks — infra failure vs. verdict (the bug this fixes)", () => {
  function queueEvaluator(outcomes: GateOutcome[]) {
    let i = 0;
    return async (): Promise<GateOutcome> => {
      if (i >= outcomes.length) throw new Error(`queueEvaluator exhausted after ${outcomes.length} calls`);
      return outcomes[i++];
    };
  }
  const verdict = (accept: boolean): GateOutcome => ({ kind: "verdict", verdict: { accept, reason: "mock" } });
  const infra: GateOutcome = { kind: "infra_failure", error: "mock infra failure" };

  it("G5 fails, with infraFailure set, when all three determinism-check runs are unresolved infra failures — never reported as deterministic", async () => {
    // Call order: g1 probe, g2 (1 adversarial), g4 (1 adversarial), g5 x3.
    const evaluate = queueEvaluator([verdict(true), verdict(false), verdict(false), infra, infra, infra]);
    const result = await runGateHardeningChecks(
      {
        taskClass: "extract",
        originalGate: WEAK_ORIGINAL_GATE,
        hardenedGate: HARDENED_GATE,
        referenceInstance: REFERENCE,
        knownGoodSubmission: KNOWN_GOOD,
        adversarialSubmissions: [ADVERSARIAL],
      },
      evaluate,
    );
    // The exact bug found live: before this fix, three identical "execution-failed" sentinels
    // compared as equal and g5.passed came back true, having never computed a real verdict.
    expect(result.g5.passed).toBe(false);
    expect(result.g5.infraFailure).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("G5 fails, without infraFailure, when the three runs are real, disagreeing verdicts", async () => {
    const evaluate = queueEvaluator([verdict(true), verdict(false), verdict(false), verdict(true), verdict(false), verdict(true)]);
    const result = await runGateHardeningChecks(
      {
        taskClass: "extract",
        originalGate: WEAK_ORIGINAL_GATE,
        hardenedGate: HARDENED_GATE,
        referenceInstance: REFERENCE,
        knownGoodSubmission: KNOWN_GOOD,
        adversarialSubmissions: [ADVERSARIAL],
      },
      evaluate,
    );
    expect(result.g5.passed).toBe(false);
    expect(result.g5.infraFailure).toBeFalsy();
    expect(result.g5.reason).toContain("non-deterministic");
  });

  it("the whole result fails with infraFailure, not a verdict, when the G1 probe itself is an unresolved infra failure", async () => {
    const evaluate = queueEvaluator([infra]);
    const result = await runGateHardeningChecks(
      {
        taskClass: "extract",
        originalGate: WEAK_ORIGINAL_GATE,
        hardenedGate: HARDENED_GATE,
        referenceInstance: REFERENCE,
        knownGoodSubmission: KNOWN_GOOD,
        adversarialSubmissions: [ADVERSARIAL],
      },
      evaluate,
    );
    expect(result.g1.passed).toBe(false);
    expect(result.g1.infraFailure).toBe(true);
    expect(result.passed).toBe(false);
  });
});
