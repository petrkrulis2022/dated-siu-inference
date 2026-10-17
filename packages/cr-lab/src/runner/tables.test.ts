import { describe, expect, it } from "vitest";
import type { AnswerRecord } from "./records.js";
import { cumulativeTable, dailyTable, failureReport } from "./tables.js";

const rec = (
  o: Partial<AnswerRecord> & Pick<AnswerRecord, "model" | "task" | "passed" | "usd">,
): AnswerRecord => ({
  schema: 1,
  window: "2026-10-20",
  part: "snapshot",
  instance: `${o.task}-${o.window ?? "2026-10-20"}-${Math.random()}`,
  provider: "anthropic",
  key: "CR_ANTHROPIC_API_KEY",
  at: "2026-10-20T12:00:00.000Z",
  data_sha256: "d".repeat(64),
  prompt_sha256: "p".repeat(64),
  day_sha256: "s".repeat(64),
  fenced: false,
  failure_classes: [],
  failures: [],
  tokens: { input: 1, output: 1, reasoning: 0, cached_input: 0 },
  latency_ms: 1,
  deviations: [],
  raw_output: "",
  ...o,
});

describe("the daily table", () => {
  const rows = [
    rec({ model: "m1", task: "CR-UO", passed: true, usd: "0.010000" }),
    rec({
      model: "m1",
      task: "CR-UO",
      passed: false,
      usd: "0.020000",
      primary_failure: "scale-slip",
      failure_classes: ["scale-slip"],
    }),
    rec({
      model: "m1",
      task: "CR-UO",
      passed: false,
      usd: "0.030000",
      primary_failure: "arithmetic",
      failure_classes: ["arithmetic"],
    }),
    rec({
      model: "m2",
      task: "CR-UO",
      passed: false,
      usd: "0.001",
      primary_failure: "no-output",
      failure_classes: ["no-output"],
    }),
  ];

  it("gives pass rate, cost per attempt and cost per correct answer, exactly, in decimals", () => {
    const t = dailyTable(rows, "2026-10-20");
    expect(t).toContain("| m1 | CR-UO | 3 | 1 | 33.3 | 0.0600 | 0.0200 | 0.0600 |");
    expect(t).toContain("| m2 | CR-UO | 1 | 0 | 0.0 | 0.0010 | 0.0010 | none correct |");
  });

  it("totals each model and then all models", () => {
    const t = dailyTable(rows, "2026-10-20");
    expect(t).toContain("| **m1** | **all** | 3 | 1 | 33.3 | 0.0600 | 0.0200 | 0.0600 |");
    expect(t).toContain("| **all models** | **all** | 4 | 1 | 25.0 | 0.0610 | 0.0153 | 0.0610 |");
  });

  it("says so when a window has no answers, rather than printing an empty table", () => {
    expect(dailyTable(rows, "2026-10-21")).toContain("No answers recorded for this window.");
  });
});

describe("the cumulative table", () => {
  it("adds windows together and names the span", () => {
    const rows = [
      rec({ model: "m1", task: "CR-VS", passed: true, usd: "1", window: "2026-10-20" }),
      rec({
        model: "m1",
        task: "CR-VS",
        passed: false,
        usd: "1",
        window: "2026-10-22",
        primary_failure: "ordering",
        failure_classes: ["ordering"],
      }),
    ];
    const t = cumulativeTable(rows);
    expect(t).toContain("Windows: 2026-10-20 to 2026-10-22 (2 windows).");
    expect(t).toContain("| m1 | CR-VS | 2 | 1 | 50.0 | 2.0000 | 1.0000 | 2.0000 |");
  });
});

describe("the failure report", () => {
  const rows = [
    rec({
      model: "m1",
      task: "CR-UO",
      passed: false,
      usd: "0",
      primary_failure: "scale-slip",
      failure_classes: ["scale-slip", "arithmetic"],
    }),
    rec({
      model: "m1",
      task: "CR-SM",
      passed: false,
      usd: "0",
      primary_failure: "ordering",
      failure_classes: ["ordering"],
    }),
    rec({
      model: "m2",
      task: "CR-SM",
      passed: false,
      usd: "0",
      primary_failure: "unclassified",
      failure_classes: ["unclassified"],
      failures: [{ code: "value", detail: "odd" }],
      instance: "CR-SM-x",
    }),
    rec({ model: "m2", task: "CR-UO", passed: true, usd: "0", fenced: true }),
  ];

  it("counts each failed answer once under its primary class, by model, and lists the secondary classes", () => {
    const t = failureReport(rows, "2026-10-20");
    expect(t).toContain("3 failed of 4 answers.");
    expect(t).toContain("| scale-slip | 1 | 0 | 1 |");
    expect(t).toContain("| ordering | 1 | 0 | 1 |");
    expect(t).toContain("Also present beside the primary class: arithmetic 1.");
  });

  it("lists every unclassified failure in full, and notes fenced replies", () => {
    const t = failureReport(rows, "2026-10-20");
    expect(t).toContain("### Unclassified, for review");
    expect(t).toContain("CR-SM-x m2: value: odd");
    expect(t).toContain("1 reply was inside a fenced block");
  });

  it("says plainly when nothing failed", () => {
    expect(
      failureReport([rec({ model: "m1", task: "CR-UO", passed: true, usd: "0" })], "2026-10-20"),
    ).toContain("No failed answers among 1 recorded.");
  });
});
