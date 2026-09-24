import { describe, expect, it } from "vitest";
import { evaluateGate, runGateHardeningChecks } from "../executor.js";
import { expectVerdict, expectVerdictReasonMatches } from "../test-helpers.js";
import {
  EXTRACT_REFERENCE,
  EXTRACT_KNOWN_GOOD,
  EXTRACT_GATE_1_TRIVIAL,
  EXTRACT_GATE_2_TEXT_SCAN,
  EXTRACT_GATE_3_HARDENED,
  EXTRACT_HELD_OUT_INSTANCES,
  EXTRACT_ANSWER_KEY_REGRESSION,
  EXTRACT_LAYOUT_SPECIFIC_REGRESSION,
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
    expectVerdict(result, true);
  }, 15000);

  it("Gate 2 (text-scan) is genuinely defeated by the duplicate-key field-order trick", async () => {
    const result = await evaluateGate(EXTRACT_GATE_2_TEXT_SCAN, EXTRACT_REFERENCE, FIELD_ORDER_GAMING);
    expectVerdict(result, true);
  }, 15000);

  it("Gate 3 (hardened) rejects every named adversarial technique and accepts the real extraction", async () => {
    // Sequential — see executor.ts's evaluateSequentially doc comment.
    const good = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, EXTRACT_KNOWN_GOOD);
    const empty = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, SCHEMA_VALID_EMPTY);
    const fabricated = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PLAUSIBLE_FABRICATION);
    const nullish = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, NULL_SEMANTICS_ADVERSARIAL);
    const reordered = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, FIELD_ORDER_GAMING);

    expectVerdict(good, true);
    expectVerdict(empty, false);
    expectVerdict(fabricated, false);
    expectVerdict(nullish, false);
    expectVerdict(reordered, false);
  }, 60000);

  it("the full G1-G6 pipeline passes hardening Gate 1 up to Gate 3", async () => {
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
      heldOutInstances: EXTRACT_HELD_OUT_INSTANCES,
    });

    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    // Real, not asserted: Gate 1 only checks "required keys present," which all four adversarial
    // submissions satisfy (even FIELD_ORDER_GAMING, whose parsed object still has every key).
    expect(result.g4.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    // G6: the rewritten hardened gate reads referenceDir/expected.json as ground-truth data — it
    // never re-derives values by parsing the document — so it must correctly accept and reject
    // across all six held-out invoices it was never authored against, including the two in
    // genuinely different real-world layouts. The real, measured proof that this fixture is a
    // verifier now, not an answer key or a layout-specific extractor.
    expect(result.g6.passed).toBe(true);
    expect(result.passed).toBe(true);
  }, 150000);
});

/**
 * The load-bearing proof for G6: it must reject the exact degenerate strategy a real single-agent
 * run actually produced, not merely a hypothetical one. If this test doesn't fail G6, G6 isn't
 * doing its job.
 */
describe("G6 catches the real answer-key gate a single-agent run actually produced", () => {
  it("EXTRACT_ANSWER_KEY_REGRESSION fails G6 even though it would have passed the old G1-G5", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: EXTRACT_GATE_1_TRIVIAL,
      hardenedGate: EXTRACT_ANSWER_KEY_REGRESSION,
      referenceInstance: EXTRACT_REFERENCE,
      knownGoodSubmission: EXTRACT_KNOWN_GOOD,
      adversarialSubmissions: [
        SCHEMA_VALID_EMPTY,
        PLAUSIBLE_FABRICATION,
        NULL_SEMANTICS_ADVERSARIAL,
        FIELD_ORDER_GAMING,
      ],
      heldOutInstances: EXTRACT_HELD_OUT_INSTANCES,
    });

    // Real, confirming the finding: against the one document it was tuned to, this gate looks
    // exactly as good as a genuine verifier.
    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    // The property that matters: it never generalizes to a document it hasn't seen.
    expect(result.g6.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 150000);

  it("EXTRACT_LAYOUT_SPECIFIC_REGRESSION fails G6 once the held-out set includes diverse layouts", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "extract",
      originalGate: EXTRACT_GATE_1_TRIVIAL,
      hardenedGate: EXTRACT_LAYOUT_SPECIFIC_REGRESSION,
      referenceInstance: EXTRACT_REFERENCE,
      knownGoodSubmission: EXTRACT_KNOWN_GOOD,
      adversarialSubmissions: [
        SCHEMA_VALID_EMPTY,
        PLAUSIBLE_FABRICATION,
        NULL_SEMANTICS_ADVERSARIAL,
        FIELD_ORDER_GAMING,
      ],
      heldOutInstances: EXTRACT_HELD_OUT_INSTANCES,
    });

    // Real, confirming the finding: it reads the source document at runtime and hard-codes
    // nothing, so it looks like a genuine verifier against the four same-layout held-out invoices.
    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    // The property that matters: a regex tuned to one document layout doesn't generalize to a
    // genuinely different one — the two diverse-layout held-out invoices are what expose it.
    expect(result.g6.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 150000);
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
    expectVerdict(result, false);
    expectVerdictReasonMatches(result, /nesting-depth limit/);
    // Caught by the guard immediately, not by the 15s wall-clock kill — the two are different
    // failure modes and this test is specifically about the former.
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);

  it("a wide, amplifying structure is rejected by the global node-count limit, not just per-level width", async () => {
    const start = Date.now();
    const result = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PATHOLOGICAL_WIDE_EXPANSION);
    expectVerdict(result, false);
    expectVerdictReasonMatches(result, /node-count limit/);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);

  it("a multi-megabyte string field is rejected before it can pressure the sandbox's memory cap", async () => {
    const start = Date.now();
    const result = await evaluateGate(EXTRACT_GATE_3_HARDENED, EXTRACT_REFERENCE, PATHOLOGICAL_HUGE_STRING);
    expectVerdict(result, false);
    // Caught by the raw-length pre-check (before JSON.parse), not the per-value string-length
    // check after parsing — this submission's JSON.stringify output already exceeds it.
    expectVerdictReasonMatches(result, /raw size limit/);
    expect(Date.now() - start).toBeLessThan(5000);
  }, 15000);
});
