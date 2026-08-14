import { describe, expect, it } from "vitest";
import { validateRunRecord } from "./run-record.js";

describe("validateRunRecord", () => {
  it("accepts a valid run record", () => {
    const result = validateRunRecord({
      run_id: "run_0001",
      model_id: "anthropic-sonnet-5",
      task_class: "T1",
      instance_id: "T1-0001",
      seed: 42,
      attempt: 1,
      usage: { input: 1000, output: 200, cached_input: 0, reasoning: 0 },
      latency_ms: 850,
      gate_passed: true,
      raw_response_ref: "data/runs/2026-08-14/run_0001.raw.json",
      deviations: [],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an attempt number beyond the 3-attempt cap", () => {
    const result = validateRunRecord({
      run_id: "run_0002",
      model_id: "anthropic-sonnet-5",
      task_class: "T3",
      instance_id: "T3-0001",
      seed: 42,
      attempt: 4,
      usage: { input: 2000, output: 400, cached_input: 0, reasoning: 0 },
      latency_ms: 1200,
      gate_passed: false,
      raw_response_ref: "data/runs/2026-08-14/run_0002.raw.json",
      deviations: [],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-enum task class", () => {
    const result = validateRunRecord({
      run_id: "run_0003",
      model_id: "anthropic-sonnet-5",
      task_class: "T4",
      instance_id: "T4-0001",
      seed: 42,
      attempt: 1,
      usage: { input: 1000, output: 200, cached_input: 0, reasoning: 0 },
      latency_ms: 850,
      gate_passed: true,
      raw_response_ref: "data/runs/2026-08-14/run_0003.raw.json",
      deviations: [],
    });
    expect(result.valid).toBe(false);
  });
});
