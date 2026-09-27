import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry, RunRecord } from "@touchstone/sdk";
import { computeSpendByProvider } from "./spend-by-provider.js";
import type { ModelPrice } from "./class-cost.js";

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    run_id: "r1",
    model_id: "m1",
    task_class: "T1",
    instance_id: "i1",
    seed: 1,
    attempt: 1,
    usage: { input: 1000, output: 1000, cached_input: 0, reasoning: 0 },
    latency_ms: 1,
    gate_passed: true,
    raw_response_ref: "r1.raw.json",
    deviations: [],
    ...overrides,
  };
}

const registry: ModelRegistryEntry[] = [
  { id: "claude-sonnet-5", provider: "anthropic", endpoint: "e", model_string: "s", tier: "frontier", open_weights: false, host: "h" },
  { id: "claude-haiku-4-5", provider: "anthropic", endpoint: "e", model_string: "s", tier: "mid", open_weights: false, host: "h" },
  { id: "gemini-3.1-pro-preview", provider: "google", endpoint: "e", model_string: "s", tier: "frontier", open_weights: false, host: "h" },
];

const prices = new Map<string, ModelPrice>([
  ["claude-sonnet-5", { price_in_usd_per_1m: "3", price_out_usd_per_1m: "15" }],
  ["claude-haiku-4-5", { price_in_usd_per_1m: "1", price_out_usd_per_1m: "5" }],
  ["gemini-3.1-pro-preview", { price_in_usd_per_1m: "2", price_out_usd_per_1m: "10" }],
]);

describe("computeSpendByProvider", () => {
  it("sums real usage across all records for one provider's models into one total", () => {
    const records = [
      record({ model_id: "claude-sonnet-5", usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
      record({ model_id: "claude-haiku-4-5", usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
    ];
    const result = computeSpendByProvider(records, registry, prices);
    expect(result).toEqual({ anthropic: "4" }); // $3 (sonnet) + $1 (haiku)
  });

  it("keeps different providers as separate keys", () => {
    const records = [
      record({ model_id: "claude-sonnet-5", usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
      record({ model_id: "gemini-3.1-pro-preview", usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
    ];
    const result = computeSpendByProvider(records, registry, prices);
    expect(result).toEqual({ anthropic: "3", google: "2" });
  });

  it("counts every attempt's real usage, not just the pass-gated ones a published cost would keep", () => {
    const records = [
      record({ model_id: "claude-sonnet-5", attempt: 1, gate_passed: false, usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
      record({ model_id: "claude-sonnet-5", attempt: 2, gate_passed: true, usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } }),
    ];
    const result = computeSpendByProvider(records, registry, prices);
    expect(result).toEqual({ anthropic: "6" }); // both attempts' real spend counted, not just the passing one
  });

  it("skips a record for a model no longer in the registry or with no price, rather than throwing", () => {
    const records = [record({ model_id: "deregistered-model", usage: { input: 1_000_000, output: 0, cached_input: 0, reasoning: 0 } })];
    expect(computeSpendByProvider(records, registry, prices)).toEqual({});
  });

  it("returns an empty object for no records", () => {
    expect(computeSpendByProvider([], registry, prices)).toEqual({});
  });
});
