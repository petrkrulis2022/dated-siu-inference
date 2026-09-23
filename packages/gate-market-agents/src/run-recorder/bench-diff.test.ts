import { describe, expect, it } from "vitest";
import { computeBenchDiff, formatBenchDiffReport } from "./bench-diff.js";

const MANIFEST_A = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/code@0.0.0",
  agentConfigs: { ORCHESTRATOR: { reasoningModel: "gpt-5.1" } },
  seed: "seed-a",
};

const MANIFEST_B = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/code@0.0.0",
  agentConfigs: { ORCHESTRATOR: { reasoningModel: "claude-sonnet-5" } },
  seed: "seed-b",
};

const METRICS_A = { turnsUsed: 2, done: true };
const METRICS_B = { turnsUsed: 5, done: true };

describe("computeBenchDiff — spec §14.4's own words: 'a report of what differed in configuration and what differed in outcome'", () => {
  it("finds no differences between two identical runs", () => {
    const report = computeBenchDiff(MANIFEST_A, MANIFEST_A, METRICS_A, METRICS_A);
    expect(report.configDifferences).toEqual([]);
    expect(report.outcomeDifferences).toEqual([]);
  });

  it("finds every differing leaf field in the manifest, by dotted path", () => {
    const report = computeBenchDiff(MANIFEST_A, MANIFEST_B, METRICS_A, METRICS_A);
    expect(report.configDifferences).toEqual(
      expect.arrayContaining([
        { path: "agentConfigs.ORCHESTRATOR.reasoningModel", a: "gpt-5.1", b: "claude-sonnet-5" },
        { path: "seed", a: "seed-a", b: "seed-b" },
      ]),
    );
    expect(report.configDifferences).toHaveLength(2);
  });

  it("finds every differing leaf field in the metrics", () => {
    const report = computeBenchDiff(MANIFEST_A, MANIFEST_A, METRICS_A, METRICS_B);
    expect(report.outcomeDifferences).toEqual([{ path: "turnsUsed", a: 2, b: 5 }]);
  });

  it("reports a value present on only one side as a difference against undefined", () => {
    const report = computeBenchDiff({ a: 1 }, { a: 1, b: 2 }, {}, {});
    expect(report.configDifferences).toEqual([{ path: "b", a: undefined, b: 2 }]);
  });
});

describe("formatBenchDiffReport", () => {
  it("renders 'none' sections when nothing differs", () => {
    const report = computeBenchDiff(MANIFEST_A, MANIFEST_A, METRICS_A, METRICS_A);
    const text = formatBenchDiffReport(report, "run-a", "run-b");
    expect(text).toContain("bench diff run-a run-b");
    expect(text).toContain("(none)");
  });

  it("renders each difference as a readable a -> b line", () => {
    const report = computeBenchDiff(MANIFEST_A, MANIFEST_A, METRICS_A, METRICS_B);
    const text = formatBenchDiffReport(report, "run-a", "run-b");
    expect(text).toContain("turnsUsed: 2  ->  5");
  });
});
