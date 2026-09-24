import { describe, expect, it } from "vitest";
import { evaluateGate, runGateHardeningChecks } from "../executor.js";
import { expectVerdict } from "../test-helpers.js";
import {
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_2_SINGLE_CASE,
  CODE_GATE_3_HARDENED,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_HELD_OUT_INSTANCES,
  CODE_HASH_ANSWER_KEY_REGRESSION,
  CODE_SUBMISSION_CONTROLLED_TEST_REGRESSION,
  CODE_TESTS_FROM_SUBMISSION_DIR_REGRESSION,
} from "./code.js";

/**
 * The real `code` reference task run end to end — not the illustrative fixtures in
 * executor.test.ts. This is WP-1's actual claim: a seeded bug real enough that a shallow test
 * suite misses it, and hardening real enough that a comprehensive one catches every named
 * adversarial technique from gate-market-spec.md §2.5.
 */
describe("the real dedupeSorted reference task", () => {
  it("Gate 1 (trivial) is genuinely defeated by the unmodified seeded bug", async () => {
    const result = await evaluateGate(CODE_GATE_1_TRIVIAL, CODE_REFERENCE, CODE_ADVERSARIAL_ORIGINAL_BUG);
    expectVerdict(result, true);
  }, 15000);

  it("Gate 2 (single case) is genuinely defeated by hard-coding the exact test input", async () => {
    const result = await evaluateGate(CODE_GATE_2_SINGLE_CASE, CODE_REFERENCE, CODE_ADVERSARIAL_HARDCODED);
    expectVerdict(result, true);
  }, 15000);

  it("Gate 3 (hardened) rejects every adversarial technique and accepts the real fix", async () => {
    // Sequential, not Promise.all — see executor.ts's own evaluateSequentially doc comment on
    // why several concurrent sandboxed evaluations proved unreliable under real host load.
    const good = await evaluateGate(CODE_GATE_3_HARDENED, CODE_REFERENCE, CODE_KNOWN_GOOD);
    const bug = await evaluateGate(CODE_GATE_3_HARDENED, CODE_REFERENCE, CODE_ADVERSARIAL_ORIGINAL_BUG);
    const hardcoded = await evaluateGate(CODE_GATE_3_HARDENED, CODE_REFERENCE, CODE_ADVERSARIAL_HARDCODED);
    const stubbed = await evaluateGate(CODE_GATE_3_HARDENED, CODE_REFERENCE, CODE_ADVERSARIAL_STUBBED);
    const swallowed = await evaluateGate(CODE_GATE_3_HARDENED, CODE_REFERENCE, CODE_ADVERSARIAL_EXCEPTION_SWALLOWING);

    expectVerdict(good, true);
    expectVerdict(bug, false);
    expectVerdict(hardcoded, false);
    expectVerdict(stubbed, false);
    expectVerdict(swallowed, false);
  }, 60000);

  it("the full G1-G6 pipeline passes hardening Gate 1 up to Gate 3", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      hardenedGate: CODE_GATE_3_HARDENED,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    });

    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    // G4 checks the ORIGINAL (Gate 1) — real, not asserted: the trivial gate's one test case
    // (a strictly-increasing array with no duplicate) can't distinguish the seeded bug, the
    // hard-coded stub, or the identity stub from a correct implementation, so all three
    // genuinely pass it.
    expect(result.g4.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    // G6: CODE_GATE_3_HARDENED dynamically invokes the submission's own function — it should
    // accept every held-out alternate correct implementation and reject every held-out wrong
    // one, proving it tests behavior rather than memorized text. This is the real, not assumed,
    // confirmation that the design-review conclusion in types.ts's own doc comment holds. Also
    // covers the 5th held-out instance (CODE_ADVERSARIAL_SHIPS_OWN_TESTS): confirms for real that
    // this gate never trusts test infrastructure shipped by the submission, since it never reads
    // anything from submissionDir except importing dedupeSorted itself.
    expect(result.g6.passed).toBe(true);
    expect(result.passed).toBe(true);
  }, 150000);
});

/**
 * Three hand-authored, permanent regression fixtures for degenerate `code` gates (code.ts's own
 * doc comment on each) — proactive hardening rather than captured from a real run, since no model
 * has authored a `code` gate yet. Each run through the same standard reference set the real
 * fixtures above use, and each genuinely fails the full pipeline — confirmed by running them for
 * real before writing these assertions, not assumed from the strategy's name. The three fail at
 * different checks, which is itself a real finding: a hash answer key looks like a working gate
 * until G6 exposes it; a gate that trusts submission-shipped test infrastructure is broken even
 * earlier, at G3, because no standard submission in this task's own format ships that
 * infrastructure at all — the exploit doesn't even need to run for the gate to be unusable.
 */
describe("permanent regression fixtures for the three named code-gate degenerate strategies", () => {
  it("CODE_HASH_ANSWER_KEY_REGRESSION passes G1-G5 but fails G6 on textually-distinct held-out known-goods", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      hardenedGate: CODE_HASH_ANSWER_KEY_REGRESSION,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    });

    // Real, confirming the finding: none of the standard adversarial submissions share
    // KNOWN_GOOD_SOURCE's exact text, and CODE_KNOWN_GOOD's hash matches itself — this gate looks
    // exactly like a working one against the fixtures it was tuned to.
    expect(result.g1.passed).toBe(true);
    expect(result.g2.passed).toBe(true);
    expect(result.g3.passed).toBe(true);
    expect(result.g4.passed).toBe(true);
    expect(result.g5.passed).toBe(true);
    // The property that matters: it never generalizes beyond the one exact fix text it memorized.
    expect(result.g6.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 150000);

  it("CODE_SUBMISSION_CONTROLLED_TEST_REGRESSION fails at G3 — real submissions never ship a package.json", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      hardenedGate: CODE_SUBMISSION_CONTROLLED_TEST_REGRESSION,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    });

    // Real, confirming the finding: spawning `npm test` from submissionDir finds no package.json
    // in ANY standard submission, including the known-good one, so this gate rejects the
    // known-good outright — broken before an adversary even has to exploit it.
    expect(result.g3.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 150000);

  it("CODE_TESTS_FROM_SUBMISSION_DIR_REGRESSION fails at G3 — real submissions never ship a test.mjs", async () => {
    const result = await runGateHardeningChecks({
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      hardenedGate: CODE_TESTS_FROM_SUBMISSION_DIR_REGRESSION,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    });

    // Real, confirming the finding: same shape as the submission-controlled test runner above —
    // no standard submission ships a test.mjs, so the known-good is rejected immediately.
    expect(result.g3.passed).toBe(false);
    expect(result.passed).toBe(false);
  }, 150000);
});
