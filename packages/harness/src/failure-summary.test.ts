import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import type { TaskInstance } from "@touchstone/basket";
import { summarizeInfraFailures, formatInfraFailureSummary } from "./failure-summary.js";
import type { InstanceOutcome } from "./orchestrator.js";

function entry(id: string): ModelRegistryEntry {
  return {
    id,
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_string: `test/${id}`,
    tier: "mid",
    open_weights: true,
    host: "testhost",
  };
}

function instance(taskClass: "T1" | "T2" | "T3"): TaskInstance {
  return {
    task_class: taskClass,
    instance_id: `${taskClass}-00`,
    seed: 1,
    prompt: "do the thing",
    params: { temperature: 0, max_tokens: 100 },
    expected: {},
  };
}

function outcome(
  registryEntry: ModelRegistryEntry,
  taskClass: "T1" | "T2" | "T3",
  overrides: Partial<InstanceOutcome> = {},
): InstanceOutcome {
  return {
    registryEntry,
    instance: instance(taskClass),
    records: [],
    passed: false,
    infraFailure: "rate limited",
    infraFailureCategory: "rate_limit",
    infraFailureRetries: 5,
    ...overrides,
  };
}

describe("summarizeInfraFailures", () => {
  it("ignores successful outcomes", () => {
    const rows = summarizeInfraFailures([
      { registryEntry: entry("a"), instance: instance("T1"), records: [], passed: true },
    ]);
    expect(rows).toEqual([]);
  });

  it("groups by model, task class, and category, counting each bucket", () => {
    const a = entry("model-a");
    const b = entry("model-b");
    const rows = summarizeInfraFailures([
      outcome(a, "T1"),
      outcome(a, "T1"),
      outcome(a, "T2", { infraFailureCategory: "timeout", infraFailure: "ETIMEDOUT" }),
      outcome(b, "T1", { infraFailureCategory: "server_error", infraFailure: "500" }),
    ]);

    expect(rows).toHaveLength(3);
    const rateLimitRow = rows.find((r) => r.category === "rate_limit");
    expect(rateLimitRow).toMatchObject({ model_id: "model-a", task_class: "T1", count: 2 });
  });

  it("sorts the largest cluster first", () => {
    const a = entry("model-a");
    const rows = summarizeInfraFailures([
      outcome(a, "T1", { infraFailureCategory: "timeout" }),
      outcome(a, "T2"),
      outcome(a, "T2"),
      outcome(a, "T2"),
    ]);
    expect(rows[0]).toMatchObject({ category: "rate_limit", count: 3 });
  });
});

describe("formatInfraFailureSummary", () => {
  it("returns an empty string when nothing failed", () => {
    expect(formatInfraFailureSummary([{ registryEntry: entry("a"), instance: instance("T1"), records: [], passed: true }])).toBe(
      "",
    );
  });

  it("names the model, task class, category, count, and an example message", () => {
    const text = formatInfraFailureSummary([outcome(entry("model-a"), "T1")]);
    expect(text).toContain("1 instance(s)");
    expect(text).toContain("model-a / T1: 1x rate_limit");
    expect(text).toContain("rate limited");
  });
});
