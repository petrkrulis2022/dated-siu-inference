import type { GateOutcome } from "../gate/types.js";
import type { OracleOutcome } from "./code-oracle.js";

/**
 * How one attack against one gate version is scored — gate verdict crossed with the independent
 * oracle's verdict (see code-oracle.ts). "The gate accepted it" is never enough on its own: an
 * adversary submitting a genuinely correct solution would otherwise score a hit.
 */
export type AttackClassification =
  | "false_accept"
  | "false_reject"
  | "correct_accept"
  | "correct_reject"
  | "inconclusive";

export interface AttackScore {
  classification: AttackClassification;
  reason: string;
  /** True only for `false_accept`. This is the number spec §3.1 calls adversarial yield. */
  countsAsAdversaryYield: boolean;
  /** True only for `false_reject` — a real finding about the gate, attributed to whoever authored
   * it, never to the adversary. */
  countsAsGateOverRejection: boolean;
}

export function scoreAttack(gate: GateOutcome, oracle: OracleOutcome): AttackScore {
  // Errors on either side are inconclusive, never a hit. Scoring an oracle failure as a rejection
  // would make "kill the oracle" the cheapest possible attack; scoring a gate error as a rejection
  // would credit the adversary for a gate that was simply broken on arrival.
  if (gate.kind !== "verdict") {
    return {
      classification: "inconclusive",
      reason: `gate did not produce a verdict (${gate.kind}): ${gate.error}`,
      countsAsAdversaryYield: false,
      countsAsGateOverRejection: false,
    };
  }
  if (oracle.kind !== "verdict") {
    return {
      classification: "inconclusive",
      reason: `oracle did not produce a verdict: ${oracle.error}`,
      countsAsAdversaryYield: false,
      countsAsGateOverRejection: false,
    };
  }

  const gateAccepted = gate.verdict.accept;
  const oracleAccepted = oracle.accept;

  if (gateAccepted && !oracleAccepted) {
    return {
      classification: "false_accept",
      reason: `gate accepted a submission the oracle rejected — ${oracle.reason}`,
      countsAsAdversaryYield: true,
      countsAsGateOverRejection: false,
    };
  }
  if (!gateAccepted && oracleAccepted) {
    return {
      classification: "false_reject",
      reason: `gate rejected a submission the oracle accepts as correct — gate said: ${gate.verdict.reason}`,
      countsAsAdversaryYield: false,
      countsAsGateOverRejection: true,
    };
  }
  if (gateAccepted && oracleAccepted) {
    return {
      classification: "correct_accept",
      reason: "submission is a correct implementation and the gate accepted it — no finding",
      countsAsAdversaryYield: false,
      countsAsGateOverRejection: false,
    };
  }
  return {
    classification: "correct_reject",
    reason: `gate correctly rejected a submission the oracle also rejects — ${oracle.reason}`,
    countsAsAdversaryYield: false,
    countsAsGateOverRejection: false,
  };
}
