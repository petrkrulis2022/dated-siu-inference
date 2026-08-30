import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import { flagSubsidised, buildPriceSnapshotFromOpenRouter, mergeSnapshots } from "./build-snapshot.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildPriceSnapshotFromOpenRouter", () => {
  it("prices each host entry from its own endpoint, not the model's generic catalog price", async () => {
    // Regression test: this bug shipped once already — using fetchOpenRouterModels()
    // (one aggregate price per model_string) instead of fetchOpenRouterEndpoints() (one
    // price per host) gave every host-pinned entry for the same model identical pricing,
    // silently erasing the provider spread the registry's multi-host entries exist to show.
    const registry: ModelRegistryEntry[] = [
      {
        id: "llama-host-a",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "meta-llama/llama-3.3-70b-instruct",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "hosta",
      },
      {
        id: "llama-host-b",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "meta-llama/llama-3.3-70b-instruct",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "hostb",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            id: "meta-llama/llama-3.3-70b-instruct",
            endpoints: [
              { provider_name: "HostA", pricing: { prompt: "0.0000001", completion: "0.0000003" } },
              { provider_name: "HostB", pricing: { prompt: "0.0000005", completion: "0.0000009" } },
            ],
          },
        }),
      })),
    );

    const { snapshot, unmatched } = await buildPriceSnapshotFromOpenRouter(registry, "t", "t");
    expect(unmatched).toEqual([]);
    const byId = Object.fromEntries(snapshot.entries.map((e) => [e.model_id, e]));
    expect(byId["llama-host-a"].price_in_usd_per_1m).toBe("0.1");
    expect(byId["llama-host-b"].price_in_usd_per_1m).toBe("0.5");
    expect(byId["llama-host-a"].price_in_usd_per_1m).not.toBe(
      byId["llama-host-b"].price_in_usd_per_1m,
    );
  });
});

const snapshot: PriceSnapshot = {
  snapshot_id: "2026-08-14T00:00:00.000Z",
  timestamp: "2026-08-14T00:00:00.000Z",
  source: "openrouter",
  entries: [
    { model_id: "above-floor", price_in_usd_per_1m: "5.00", price_out_usd_per_1m: "10.00" },
    { model_id: "below-floor-input", price_in_usd_per_1m: "0.50", price_out_usd_per_1m: "10.00" },
    { model_id: "below-floor-output", price_in_usd_per_1m: "5.00", price_out_usd_per_1m: "0.50" },
  ],
};

describe("flagSubsidised", () => {
  it("flags entries priced below the floor on either input or output, leaves others untouched", () => {
    const result = flagSubsidised(snapshot, "1.00");
    const byId = Object.fromEntries(result.entries.map((e) => [e.model_id, e]));

    expect(byId["above-floor"].subsidised).toBeUndefined();
    expect(byId["below-floor-input"].subsidised).toBe(true);
    expect(byId["below-floor-output"].subsidised).toBe(true);
  });

  it("does not mutate the input snapshot", () => {
    flagSubsidised(snapshot, "1.00");
    expect(snapshot.entries[1].subsidised).toBeUndefined();
  });
});

describe("mergeSnapshots", () => {
  const openrouter: PriceSnapshot = {
    snapshot_id: "or-1",
    timestamp: "2026-08-30T00:00:00Z",
    source: "openrouter",
    entries: [
      { model_id: "open-weight-a", price_in_usd_per_1m: "0.10", price_out_usd_per_1m: "0.20" },
    ],
  };
  const litellm: PriceSnapshot = {
    snapshot_id: "ll-1",
    timestamp: "2026-08-30T00:00:00Z",
    source: "litellm",
    entries: [
      // Present in both — openrouter's price must win, not this one.
      { model_id: "open-weight-a", price_in_usd_per_1m: "9.99", price_out_usd_per_1m: "9.99" },
      // Direct-provider frontier model — no OpenRouter presence at all, litellm is the only price.
      { model_id: "frontier-b", price_in_usd_per_1m: "2.00", price_out_usd_per_1m: "10.00" },
    ],
  };

  it("keeps openrouter's price for a model present in both, never the litellm one", () => {
    const { snapshot } = mergeSnapshots(openrouter, litellm, "merged-1", "2026-08-30T00:00:00Z");
    const entry = snapshot.entries.find((e) => e.model_id === "open-weight-a");
    expect(entry).toEqual({
      model_id: "open-weight-a",
      price_in_usd_per_1m: "0.10",
      price_out_usd_per_1m: "0.20",
    });
  });

  it("falls back to litellm for a model with no OpenRouter presence at all", () => {
    const { snapshot, fromLiteLLM } = mergeSnapshots(
      openrouter,
      litellm,
      "merged-1",
      "2026-08-30T00:00:00Z",
    );
    const entry = snapshot.entries.find((e) => e.model_id === "frontier-b");
    expect(entry).toEqual({
      model_id: "frontier-b",
      price_in_usd_per_1m: "2.00",
      price_out_usd_per_1m: "10.00",
    });
    expect(fromLiteLLM).toEqual(["frontier-b"]);
  });

  it("labels the result source as merged", () => {
    const { snapshot } = mergeSnapshots(openrouter, litellm, "merged-1", "2026-08-30T00:00:00Z");
    expect(snapshot.source).toBe("merged");
  });
});
