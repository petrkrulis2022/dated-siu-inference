import { describe, expect, it } from "vitest";
import type { TaskInstance } from "@datum/basket";
import { buildRunRecord } from "./run-record.js";
import type { AdapterResult } from "./adapters/types.js";

const instance: TaskInstance = {
  task_class: "T1",
  instance_id: "T1-00",
  seed: 42,
  prompt: "prompt text",
  params: { temperature: 0, max_tokens: 100 },
  expected: {},
};

const adapterResult: AdapterResult = {
  text: "response text",
  usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
  latency_ms: 812.7,
  raw: { some: "raw payload" },
  deviations: [],
};

describe("buildRunRecord", () => {
  it("builds a schema-valid run record from an adapter result and grade", () => {
    const record = buildRunRecord(
      "run-001",
      "model-a",
      instance,
      1,
      adapterResult,
      { passed: true },
      "run-001.raw.json",
    );
    expect(record.model_id).toBe("model-a");
    expect(record.task_class).toBe("T1");
    expect(record.instance_id).toBe("T1-00");
    expect(record.seed).toBe(42);
    expect(record.attempt).toBe(1);
    expect(record.gate_passed).toBe(true);
    expect(record.usage).toEqual(adapterResult.usage);
    expect(record.raw_response_ref).toBe("run-001.raw.json");
    expect(record.run_id).toBeTruthy();
  });

  it("rounds fractional latency to an integer (schema requires an integer)", () => {
    const record = buildRunRecord(
      "run-002",
      "model-a",
      instance,
      1,
      adapterResult,
      { passed: true },
      "ref.json",
    );
    expect(Number.isInteger(record.latency_ms)).toBe(true);
  });

  it("carries deviations through from the adapter result", () => {
    const withDeviation = {
      ...adapterResult,
      deviations: ["temperature forced to provider default"],
    };
    const record = buildRunRecord(
      "run-003",
      "model-a",
      instance,
      1,
      withDeviation,
      { passed: true },
      "ref.json",
    );
    expect(record.deviations).toEqual(["temperature forced to provider default"]);
  });

  it("records gate_passed: false for a failing grade", () => {
    const record = buildRunRecord(
      "run-004",
      "model-a",
      instance,
      1,
      adapterResult,
      { passed: false, reason: "wrong" },
      "ref.json",
    );
    expect(record.gate_passed).toBe(false);
  });
});
