import { describe, expect, it } from "vitest";
import { evaluateGate, runGateHardeningChecks } from "../executor.js";
import {
  EXTRACT_REFERENCE,
  EXTRACT_KNOWN_GOOD,
  EXTRACT_GATE_1_TRIVIAL,
  EXTRACT_GATE_2_TEXT_SCAN,
  EXTRACT_GATE_3_HARDENED,
  SCHEMA_VALID_EMPTY,
  PLAUSIBLE_FABRICATION,
  NULL_SEMANTICS_ADVERSARIAL,
  FIELD_ORDER_GAMING,
  PATHOLOGICAL_DEEP_NESTING,
  PATHOLOGICAL_WIDE_EXPANSION,
  PATHOLOGICAL_HUGE_STRING,
} from "./extract.js";

/**
 * The real `extract` reference task, run end to end. Every gate here runs inside the same
 * runSandboxed boundary as the `code` class — resolved deliberately per review, 2026-09-22:
 * "it's just JSON" is not an exemption, and the pathological fixtures below exist specifically to
 * prove that in practice, not just assert it in a comment.
 */
describe("the real invoice-extraction reference task", () => {
  it("Gate 1 (trivial) is genuinely defeated by an all-empty, schema-valid submission", async () => {
    const result = await evaluateGate(EXTRACT_GATE_1_TRIVIAL, EXTRACT_REFERENCE, SCHEMA_VALID_EMPTY);
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(true);
  }, 15000);

  it("Gate 2 (text-scan) is genuinely defeated by the duplicate-key field-order trick", async () => {
    const result = await evaluateGate(EXTRACT_GATE_2_TEXT_SCAN, EXTRACT_REFERENCE, FIELD_ORDER_GAMING);
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(true);
  }, 15000);

  it("Gate 3 (hardened) rejects every named adversarial technique and accepts the real extraction", async () => {
    // Sequential — see executor.ts's evaluateSequentially doc comment.
    const good = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, EXTRACT_KNOWN_GOOD);
    const empty = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, SCHEMA_VALID_EMPTY);
    const fabricated = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PLAUSIBLE_FABRICATION);
    const nullish = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, NULL_SEMANTICS_ADVERSARIAL);
    const reordered = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, FIELD_ORDER_GAMING);

    expect(good.verdict?.accept).toBe(true);
    expect(empty.verdict?.accept).toBe(false);
    expect(fabricated.verdict?.accept).toBe(false);
    expect(nullish.verdict?.accept).toBe(false);
    expect(reordered.verdict?.accept).toBe(false);
  }, 60000);

  it("the full G1-G5 pipeline passes hardening Gate 1 up to Gate 3", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: EXTRACT_GATE_1_TRIVIAL,
      hardenedGate: EXTRACT_GATE_3_HARDENED,
      referenceInstance: EXTRACT_REFERENCE,
      knownGoodSubmission: EXTRACT_KNOWN_GOOD,
      adversarialSubmissions: [
        SCHEMA_VALID_EMPTY,
        PLAUSIBLE_FABRICATION,
        NULL_SEMANTICS_ADVERSARIAL,
        FIELD_ORDER_GAMING,
      ],
    });

    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    // Real, not asserted: Gate 1 only checks "required keys present," which all four adversarial
    // submissions satisfy (even FIELD_ORDER_GAMING, whose parsed object still has every key).
    expect(result.g4.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    expect(result.passed).toBe(true);
  }, 90000);
});

/**
 * The execution-boundary decision itself, verified: pathological JSON submissions are rejected
 * by the validator's own guards, inside the sandbox, without hanging or crashing the harness.
 * Not the same claim as "the sandbox's OS-level memory cap works" — that's already proven
 * generically in sandbox/hostile-fixture.test.ts. This proves the *validator's own* explicit
 * guards (node-count, depth, string-length) catch these shapes specifically, which is new code.
 */
describe("pathological submissions against the extract gate", () => {
  it("deep nesting is rejected, not stack-overflowed or hung", async () => {
    const start = Date.now();
    const result = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PATHOLOGICAL_DEEP_NESTING);
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(false);
    expect(result.verdict?.reason).toMatch(/nesting-depth limit/);
    // Caught by the guard immediately, not by the 15s wall-clock kill — the two are different
    // failure modes and this test is specifically about the former.
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);

  it("a wide, amplifying structure is rejected by the global node-count limit, not just per-level width", async () => {
    const start = Date.now();
    const result = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PATHOLOGICAL_WIDE_EXPANSION);
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(false);
    expect(result.verdict?.reason).toMatch(/node-count limit/);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);

  it("a multi-megabyte string field is rejected before it can pressure the sandbox's memory cap", async () => {
    const start = Date.now();
    const result = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PATHOLOGICAL_HUGE_STRING);
    expect(result.ok).toBe(true);
    expect(result.verdict?.accept).toBe(false);
    // Caught by the raw-length pre-check (before JSON.parse), not the per-value string-length
    // check after parsing — this submission's JSON.stringify output already exceeds it.
    expect(result.verdict?.reason).toMatch(/raw size limit/);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);
});
