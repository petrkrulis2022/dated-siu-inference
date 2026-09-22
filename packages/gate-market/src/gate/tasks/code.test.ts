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

  it("the full G1-G5 pipeline passes hardening Gate 1 up to Gate 3", async () => {
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
    expect(result.passed).toBe(true);
  }, 90000);
});
