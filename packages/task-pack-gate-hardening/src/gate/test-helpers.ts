import { expect } from "vitest";
import type { GateOutcome } from "./types.js";

/** Asserts a GateOutcome resolved to a real, computed verdict with the given accept value —
 * never silently passes for a gate_error or infra_failure just because neither is `true`/`false`
 * either. Centralised so every test in this package narrows GateOutcome the same, explicit way. */
export function expectVerdict(outcome: GateOutcome, expected: boolean): void {
  expect(outcome.kind, `expected a verdict outcome, got ${outcome.kind}`).toBe("verdict");
  if (outcome.kind === "verdict") {
    expect(outcome.verdict.accept).toBe(expected);
  }
}

export function expectVerdictReasonMatches(outcome: GateOutcome, pattern: RegExp): void {
  expect(outcome.kind, `expected a verdict outcome, got ${outcome.kind}`).toBe("verdict");
  if (outcome.kind === "verdict") {
    expect(outcome.verdict.reason).toMatch(pattern);
  }
}

export function expectGateError(outcome: GateOutcome): void {
  expect(outcome.kind, `expected a gate_error outcome, got ${outcome.kind}`).toBe("gate_error");
}
