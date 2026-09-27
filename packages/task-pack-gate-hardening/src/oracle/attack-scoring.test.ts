import { describe, expect, it } from "vitest";
import { scoreAttack } from "./attack-scoring.js";
import type { GateOutcome } from "../gate/types.js";
import type { OracleOutcome } from "./code-oracle.js";

const gateAccepts: GateOutcome = { kind: "verdict", verdict: { accept: true, reason: "all tests passed" } };
const gateRejects: GateOutcome = { kind: "verdict", verdict: { accept: false, reason: "2 tests failed" } };
const gateBroken: GateOutcome = { kind: "gate_error", error: "no exported gate()" };
const gateInfra: GateOutcome = { kind: "infra_failure", error: "sandbox timed out" };

const oracleAccepts: OracleOutcome = { kind: "verdict", accept: true, reason: "matched on all trials", trialsRun: 500 };
const oracleRejects: OracleOutcome = {
  kind: "verdict",
  accept: false,
  reason: "disagreed on trial 3",
  trialsRun: 500,
  firstMismatch: { input: [1, 1], expected: [1], actual: [1, 1] },
};
const oracleBroken: OracleOutcome = { kind: "oracle_error", error: "no readable oracle result" };

describe("scoreAttack", () => {
  it("scores gate-accepts + oracle-rejects as a false accept, the only thing that counts as yield", () => {
    const score = scoreAttack(gateAccepts, oracleRejects);
    expect(score.classification).toBe("false_accept");
    expect(score.countsAsAdversaryYield).toBe(true);
    expect(score.countsAsGateOverRejection).toBe(false);
  });

  it("scores gate-rejects + oracle-accepts as a false reject, attributed to the gate, not the adversary", () => {
    const score = scoreAttack(gateRejects, oracleAccepts);
    expect(score.classification).toBe("false_reject");
    expect(score.countsAsAdversaryYield).toBe(false);
    expect(score.countsAsGateOverRejection).toBe(true);
  });

  it("scores a correct submission the gate accepted as nothing at all", () => {
    const score = scoreAttack(gateAccepts, oracleAccepts);
    expect(score.classification).toBe("correct_accept");
    expect(score.countsAsAdversaryYield).toBe(false);
    expect(score.countsAsGateOverRejection).toBe(false);
  });

  it("scores a bad submission the gate correctly rejected as nothing at all", () => {
    const score = scoreAttack(gateRejects, oracleRejects);
    expect(score.classification).toBe("correct_reject");
    expect(score.countsAsAdversaryYield).toBe(false);
    expect(score.countsAsGateOverRejection).toBe(false);
  });

  // An oracle that failed must never be read as a rejection: a rejection is half of what a false
  // accept is made from, so that would make "break the oracle" the cheapest attack there is.
  it("scores a broken oracle as inconclusive even when the gate accepted", () => {
    const score = scoreAttack(gateAccepts, oracleBroken);
    expect(score.classification).toBe("inconclusive");
    expect(score.countsAsAdversaryYield).toBe(false);
  });

  it("scores a broken gate as inconclusive rather than crediting the adversary", () => {
    expect(scoreAttack(gateBroken, oracleRejects).classification).toBe("inconclusive");
    expect(scoreAttack(gateBroken, oracleRejects).countsAsAdversaryYield).toBe(false);
    expect(scoreAttack(gateInfra, oracleRejects).classification).toBe("inconclusive");
    expect(scoreAttack(gateInfra, oracleRejects).countsAsAdversaryYield).toBe(false);
  });

  it("never counts both a yield and an over-rejection for the same attack", () => {
    const cases: [GateOutcome, OracleOutcome][] = [
      [gateAccepts, oracleAccepts], [gateAccepts, oracleRejects],
      [gateRejects, oracleAccepts], [gateRejects, oracleRejects],
      [gateBroken, oracleBroken], [gateInfra, oracleAccepts],
    ];
    for (const [gate, oracle] of cases) {
      const score = scoreAttack(gate, oracle);
      expect(score.countsAsAdversaryYield && score.countsAsGateOverRejection).toBe(false);
    }
  });
});
