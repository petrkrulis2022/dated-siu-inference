import { describe, expect, it } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import { ModelPriceNotFoundError, modelPricesFor } from "./model-prices.js";

const REGISTRY: ModelRegistryEntry[] = [
  {
    id: "claude-sonnet-5",
    provider: "anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    model_string: "claude-sonnet-5",
    tier: "frontier",
    open_weights: false,
    host: "anthropic",
  },
];

const SNAPSHOT: PriceSnapshot = {
  snapshot_id: "s1",
  timestamp: "2026-09-25T00:00:00Z",
  source: "merged",
  entries: [
    { model_id: "claude-sonnet-5", price_in_usd_per_1m: "2", price_out_usd_per_1m: "10" },
  ],
};

describe("modelPricesFor", () => {
  it("returns the real snapshot entry's price for a registered, priced model", () => {
    expect(modelPricesFor("claude-sonnet-5", REGISTRY, SNAPSHOT)).toEqual({
      priceInUsdPer1M: "2",
      priceOutUsdPer1M: "10",
    });
  });

  it("throws, never guesses, for a model absent from the registry", () => {
    expect(() => modelPricesFor("gpt-5.1", REGISTRY, SNAPSHOT)).toThrow(ModelPriceNotFoundError);
  });

  it("throws, never guesses, for a registered model with no snapshot price", () => {
    const registryWithUnpriced: ModelRegistryEntry[] = [
      ...REGISTRY,
      {
        id: "gpt-5.1",
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model_string: "gpt-5.1",
        tier: "frontier",
        open_weights: false,
        host: "openai",
      },
    ];
    expect(() => modelPricesFor("gpt-5.1", registryWithUnpriced, SNAPSHOT)).toThrow(
      ModelPriceNotFoundError,
    );
  });
});
