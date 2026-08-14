import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot } from "@datum/sdk";
import { flagSubsidised, buildPriceSnapshotFromOpenRouter } from "./build-snapshot.js";

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
