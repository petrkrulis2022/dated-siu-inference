import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import type { TaskInstance } from "@touchstone/basket";
import { estimateCost, estimateInputTokens } from "./dry-run.js";

const registry: ModelRegistryEntry[] = [
  {
    id: "model-a",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_string: "vendor/model-a",
    tier: "mid",
    open_weights: true,
    host: "hosta",
  },
  {
    id: "model-unpriced",
    provider: "openrouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model_string: "vendor/model-unpriced",
    tier: "mid",
    open_weights: true,
    host: "hosta",
  },
];

const priceSnapshot: PriceSnapshot = {
  snapshot_id: "snap-1",
  timestamp: "2026-08-14T00:00:00.000Z",
  source: "openrouter",
  entries: [{ model_id: "model-a", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
};

function makeInstance(promptLength: number, maxTokens: number): TaskInstance {
  return {
    task_class: "T1",
    instance_id: "T1-00",
    seed: 1,
    prompt: "x".repeat(promptLength),
    params: { temperature: 0, max_tokens: maxTokens },
    expected: {},
  };
}

describe("estimateInputTokens", () => {
  it("approximates ~4 characters per token", () => {
    expect(estimateInputTokens("x".repeat(400))).toBe(100);
    expect(estimateInputTokens("")).toBe(0);
  });
});

describe("estimateCost", () => {
  it("computes cost per line item from input-length estimate and max_tokens as output ceiling", () => {
    const instance = makeInstance(4000, 500); // 1000 estimated input tokens
    const result = estimateCost(registry, priceSnapshot, [instance]);

    const item = result.line_items.find((i) => i.model_id === "model-a");
    expect(item?.estimated_input_tokens).toBe(1000);
    expect(item?.estimated_output_tokens).toBe(500);
    // (1000/1e6 * 1.00) + (500/1e6 * 2.00) = 0.001 + 0.001 = 0.002
    expect(item?.estimated_cost_usd).toBe("0.002");
  });

  it("excludes unpriced models from line items and the total, and reports them separately", () => {
    const instance = makeInstance(400, 100);
    const result = estimateCost(registry, priceSnapshot, [instance]);

    expect(result.unpriced_models).toEqual(["model-unpriced"]);
    expect(result.line_items.every((i) => i.model_id !== "model-unpriced")).toBe(true);
  });

  it("sums all line items into the total", () => {
    const instances = [makeInstance(4000, 500), makeInstance(4000, 500)];
    const result = estimateCost(registry, priceSnapshot, instances);
    expect(result.line_items).toHaveLength(2);
    expect(result.total_usd).toBe("0.004");
  });

  it("produces zero cost and an empty total when there are no registry models priced", () => {
    const result = estimateCost([registry[1]], priceSnapshot, [makeInstance(400, 100)]);
    expect(result.line_items).toEqual([]);
    expect(result.total_usd).toBe("0");
  });
});
