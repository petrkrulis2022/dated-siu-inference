import { describe, expect, it } from "vitest";
import {
  BUGGY_SOURCE,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_3_HARDENED,
  CODE_REFERENCE,
  KNOWN_GOOD_SOURCE,
} from "@touchstone/task-pack-gate-hardening";
import { submitAttackTool, type AttackToolResult } from "./submit-attack.js";
import type { ToolContext } from "../deps.js";

const SEED = 20260927;
/** The tool never touches the chain, the model, or the print — it runs two sandboxes and scores
 * the pair, so nothing in `ToolContext` is reachable from its handler. */
const ctx = {} as ToolContext;

async function attack(gateSource: string, submissionSource: string): Promise<AttackToolResult> {
  return submitAttackTool.handler(ctx, {
    submissionSource,
    targetGateSource: gateSource,
    taskClass: "code",
    referenceFiles: CODE_REFERENCE.files,
    oracleSeed: SEED,
    gateVersion: 1,
  });
}

describe("submit_attack — the real end-to-end adversary path", () => {
  // The finding the whole mechanism exists to produce. Gate 1 only ever tests [1, 2, 3], which
  // has no duplicates — and the seeded `>=` bug produces identical output for exactly that input.
  // So the gate accepts it while the oracle, which does exercise duplicates, does not.
  it("scores a genuine false accept: a weak gate accepts the seeded bug, the oracle rejects it", async () => {
    const result = await attack(CODE_GATE_1_TRIVIAL.source, BUGGY_SOURCE);
    expect(result.gate.accept).toBe(true);
    expect(result.oracle.accept).toBe(false);
    expect(result.classification).toBe("false_accept");
    expect(result.countsAsAdversaryYield).toBe(true);
  }, 90_000);

  it("scores nothing when a hardened gate catches the same submission", async () => {
    const result = await attack(CODE_GATE_3_HARDENED.source, BUGGY_SOURCE);
    expect(result.gate.accept).toBe(false);
    expect(result.oracle.accept).toBe(false);
    expect(result.classification).toBe("correct_reject");
    expect(result.countsAsAdversaryYield).toBe(false);
  }, 90_000);

  // The property that stops an adversary farming yield by simply solving the task.
  it("scores nothing for a correct submission the gate accepts", async () => {
    const result = await attack(CODE_GATE_3_HARDENED.source, KNOWN_GOOD_SOURCE);
    expect(result.gate.accept).toBe(true);
    expect(result.oracle.accept).toBe(true);
    expect(result.classification).toBe("correct_accept");
    expect(result.countsAsAdversaryYield).toBe(false);
  }, 90_000);

  it("reports inconclusive, never a yield, when the gate itself is broken", async () => {
    const result = await attack("export const notAGate = 1;\n", BUGGY_SOURCE);
    expect(result.classification).toBe("inconclusive");
    expect(result.countsAsAdversaryYield).toBe(false);
  }, 90_000);

  it("carries the oracle seed and gate version through to the result, for the run record", async () => {
    const result = await attack(CODE_GATE_1_TRIVIAL.source, KNOWN_GOOD_SOURCE);
    expect(result.oracleSeed).toBe(SEED);
    expect(result.gateVersion).toBe(1);
  }, 90_000);
});
