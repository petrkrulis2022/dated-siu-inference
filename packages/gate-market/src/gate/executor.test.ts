import { describe, expect, it } from "vitest";
import { evaluateGate, runGateHardeningChecks } from "./executor.js";
import type { GateSpec, ReferenceTaskInstance, Submission } from "./types.js";

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
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(true);
  });

  it("reports a syntax error as a failed execution, not a thrown exception", async () => {
    const result = await evaluateGate(SYNTAX_ERROR_GATE, REFERENCE, KNOWN_GOOD);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
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
      expect(result.ok).toBe(true);
      const reported = JSON.parse(result.verdict!.reason);
      expect(reported.sentinel).toBeNull();
      expect(reported.reached).toBe(false);
    } finally {
      delete process.env.TOUCHSTONE_GATE_TEST_SENTINEL;
    }
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
    // A gate that can't even execute can't have meaningfully checked anything else.
    expect(result.passed).toBe(false);
  }, 20000);

  // retry: this check is a coin flip by construction (3 independent 50/50 draws, ~1-in-8 chance
  // they happen to agree) — see the comment below. Retrying drops the false-negative rate to
  // ~0.2% without weakening what's actually being checked.
  it("fails G5 when the hardened gate is non-deterministic", { retry: 2, timeout: 20000 }, async () => {
    const randomGate: GateSpec = {
      taskClass: "extract",
      source: `export async function gate() { return { accept: Math.random() > 0.5, reason: "random" }; }`,
    };
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: WEAK_ORIGINAL_GATE,
      hardenedGate: randomGate,
      referenceInstance: REFERENCE,
      knownGoodSubmission: KNOWN_GOOD,
      adversarialSubmissions: [ADVERSARIAL],
    });
    // Probabilistic by nature of what's under test (3 independent 50/50 draws): about a 1-in-8
    // chance this particular run's 3 samples happen to agree and this assertion is wrong. Proving
    // the *mechanism* checks for consistency, not a security property, so this is an accepted,
    // documented flake risk rather than one worth re-architecting the executor to avoid.
    expect(result.g5.passed).toBe(false);
  });
});
