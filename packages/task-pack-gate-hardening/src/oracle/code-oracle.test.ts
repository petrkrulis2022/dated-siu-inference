import { describe, expect, it } from "vitest";
import { buildOracleTrials, referenceDedupeSorted, runCodeOracle } from "./code-oracle.js";
import { BUGGY_SOURCE, CODE_KNOWN_GOOD, KNOWN_GOOD_SOURCE } from "../gate/tasks/code.js";

const SEED = 20260927;

describe("buildOracleTrials", () => {
  it("is exactly reproducible from its seed — the property that makes recording the seed worth anything", () => {
    expect(buildOracleTrials(SEED, 50)).toEqual(buildOracleTrials(SEED, 50));
  });

  it("produces a different trial set for a different seed", () => {
    expect(buildOracleTrials(SEED, 50)).not.toEqual(buildOracleTrials(SEED + 1, 50));
  });

  it("generates sorted inputs whose expected output is the reference dedupe", () => {
    for (const trial of buildOracleTrials(SEED, 100)) {
      expect([...trial.input].sort((a, b) => a - b)).toEqual(trial.input);
      expect(trial.expected).toEqual(referenceDedupeSorted(trial.input));
    }
  });

  it("actually exercises duplicates — a trial set without them could not catch the seeded bug", () => {
    const withDuplicates = buildOracleTrials(SEED, 100).filter(
      (t) => t.expected.length < t.input.length,
    );
    expect(withDuplicates.length).toBeGreaterThan(10);
  });
});

describe("runCodeOracle", () => {
  it("accepts the known-good implementation", async () => {
    const outcome = await runCodeOracle(CODE_KNOWN_GOOD, { seed: SEED, trials: 60 });
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(true);
  }, 60_000);

  it("rejects the seeded buggy implementation, with a real counterexample", async () => {
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": BUGGY_SOURCE } },
      { seed: SEED, trials: 60 },
    );
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(false);
    expect(outcome.firstMismatch).toBeDefined();
    // The counterexample must genuinely disagree — not just be reported as one.
    expect(outcome.firstMismatch!.expected).toEqual(
      referenceDedupeSorted(outcome.firstMismatch!.input),
    );
    expect(outcome.firstMismatch!.actual).not.toEqual(outcome.firstMismatch!.expected);
  }, 60_000);

  it("rejects a submission that throws rather than calling it an oracle error", async () => {
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": 'export function dedupeSorted() { throw new Error("nope"); }\n' } },
      { seed: SEED, trials: 20 },
    );
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(false);
  }, 60_000);

  it("rejects a submission that returns its input unchanged", async () => {
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": "export function dedupeSorted(arr) { return arr; }\n" } },
      { seed: SEED, trials: 60 },
    );
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(false);
  }, 60_000);

  it("accepts a correct implementation written differently from the reference", async () => {
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": "export function dedupeSorted(arr) { return [...new Set(arr)]; }\n" } },
      { seed: SEED, trials: 60 },
    );
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(true);
  }, 60_000);

  // The safety property the whole scoring rule rests on: a submission that destroys the oracle's
  // own result must never come back as a *rejection*, because a rejection is what a false accept
  // is scored from. If this regressed, "crash the oracle" would be the cheapest attack available.
  it("reports oracle_error, never a rejection, when the submission kills the run at import time", async () => {
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": "process.exit(0);\nexport function dedupeSorted(arr) { return arr; }\n" } },
      { seed: SEED, trials: 20 },
    );
    expect(outcome.kind).toBe("oracle_error");
  }, 60_000);

  it("reports oracle_error, never a rejection, when the submission truncates its own result file", async () => {
    const source = [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync("/scratch/oracle-result.json", JSON.stringify({ completed: true, outputs: [[1]] }));',
      "process.exit(0);",
      "export function dedupeSorted(arr) { return arr; }",
    ].join("\n");
    const outcome = await runCodeOracle({ files: { "answer.mjs": source } }, { seed: SEED, trials: 20 });
    expect(outcome.kind).toBe("oracle_error");
  }, 60_000);

  it("never hands the submission the expected outputs — only the inputs are staged", async () => {
    // A submission that could read the answer key would trivially pass; this proves it cannot, by
    // reporting back whatever the trials file actually contains.
    const source = [
      'import { readFileSync } from "node:fs";',
      'const raw = readFileSync("/scratch/trials.json", "utf-8");',
      "export function dedupeSorted() { return JSON.parse(raw)[0]; }",
    ].join("\n");
    const outcome = await runCodeOracle({ files: { "answer.mjs": source } }, { seed: SEED, trials: 20 });
    // trials.json holds inputs only, so the best this can do is echo an input — which is wrong for
    // every trial whose expected output differs from the first input.
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(false);
  }, 60_000);

  it("scores the known-good source and the reference implementation identically", async () => {
    expect(KNOWN_GOOD_SOURCE).toContain("!==");
    const outcome = await runCodeOracle(
      { files: { "answer.mjs": KNOWN_GOOD_SOURCE } },
      { seed: SEED + 7, trials: 60 },
    );
    expect(outcome.kind).toBe("verdict");
    if (outcome.kind !== "verdict") return;
    expect(outcome.accept).toBe(true);
  }, 60_000);
});
