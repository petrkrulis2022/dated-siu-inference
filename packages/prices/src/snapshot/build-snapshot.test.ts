import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import {
  flagSubsidised,
  buildPriceSnapshotFromOpenRouter,
  buildPriceSnapshotFromLiteLLM,
  mergeSnapshots,
} from "./build-snapshot.js";

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
        listed_tiers: [],
      },
      {
        id: "llama-host-b",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "meta-llama/llama-3.3-70b-instruct",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "hostb",
        listed_tiers: [],
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

  it("prices a host naming one exact endpoint (deepinfra/fp8) from that endpoint, not the provider's first-listed one", async () => {
    // Found live, 2026-11-18: OpenRouter lists several endpoints under one provider name, one per
    // service tier (DeepInfra: "deepinfra/fp8/flex", "deepinfra/fp8", "deepinfra/fp8/priority"),
    // each at its own price. A host of just "deepinfra" matches the first one listed (flex here),
    // while the calls themselves are billed at whichever tier serves them. A registry host that
    // names the exact endpoint the harness pins its calls to must be priced from that endpoint.
    const registry: ModelRegistryEntry[] = [
      {
        id: "mistral-small-3.2-24b-deepinfra",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "mistralai/mistral-small-3.2-24b-instruct",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "deepinfra/fp8",
        listed_tiers: ["deepinfra/fp8/flex", "deepinfra/fp8/priority"],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            id: "mistralai/mistral-small-3.2-24b-instruct",
            endpoints: [
              { provider_name: "DeepInfra", tag: "deepinfra/fp8/flex", pricing: { prompt: "0.00000006", completion: "0.00000016" } },
              { provider_name: "DeepInfra", tag: "deepinfra/fp8", pricing: { prompt: "0.000000075", completion: "0.0000002" } },
              { provider_name: "DeepInfra", tag: "deepinfra/fp8/priority", pricing: { prompt: "0.0000001125", completion: "0.0000003" } },
            ],
          },
        }),
      })),
    );

    const { snapshot, unmatched } = await buildPriceSnapshotFromOpenRouter(registry, "t", "t");
    expect(unmatched).toEqual([]);
    expect(snapshot.entries[0].price_in_usd_per_1m).toBe("0.075");
    expect(snapshot.entries[0].price_out_usd_per_1m).toBe("0.2");
  });

  it("captures a published input_cache_read as price_cached_in_usd_per_1m", async () => {
    // Found live, 2026-09-25: OpenRouter's own per-host endpoint pricing already carries this
    // field when the host publishes one — this builder simply never read it before, so real,
    // billed cached_input usage on every OpenRouter-routed model priced at zero regardless of
    // what the host actually charged (docs/methodology.md's Cache policy section). Confirmed
    // against the real endpoints API for deepseek-v3.2 (DeepInfra, $0.13/1M cached input).
    const registry: ModelRegistryEntry[] = [
      {
        id: "deepseek-v3.2",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "deepseek/deepseek-v3.2",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "deepinfra",
        listed_tiers: [],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            id: "deepseek/deepseek-v3.2",
            endpoints: [
              {
                provider_name: "DeepInfra",
                pricing: { prompt: "0.00000026", completion: "0.00000038", input_cache_read: "0.00000013" },
              },
            ],
          },
        }),
      })),
    );

    const { snapshot } = await buildPriceSnapshotFromOpenRouter(registry, "t", "t");
    expect(snapshot.entries[0].price_cached_in_usd_per_1m).toBe("0.13");
  });

  it("omits price_cached_in_usd_per_1m entirely when the host has no cache rate", async () => {
    // Absent, not defaulted to "0" or to the input rate — same discipline
    // buildPriceSnapshotFromLiteLLM's own equivalent case already holds to.
    const registry: ModelRegistryEntry[] = [
      {
        id: "mistral-small-3.2-24b-instruct",
        provider: "openrouter",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model_string: "mistralai/mistral-small-3.2-24b-instruct",
        tier: "open-weight-hosted",
        open_weights: true,
        host: "deepinfra",
        listed_tiers: [],
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          data: {
            id: "mistralai/mistral-small-3.2-24b-instruct",
            endpoints: [
              { provider_name: "DeepInfra", pricing: { prompt: "0.000000075", completion: "0.0000002" } },
            ],
          },
        }),
      })),
    );

    const { snapshot } = await buildPriceSnapshotFromOpenRouter(registry, "t", "t");
    expect(snapshot.entries[0]).not.toHaveProperty("price_cached_in_usd_per_1m");
  });

  // rules-2026-11-20. Found live: from the 2026-11-17 snapshot, qwen-2.5-72b-instruct (host "deepinfra") was priced at DeepInfra's flex tier,
  // listed first, $0.288/$0.32, while every one of its calls was billed at the standard endpoint's $0.36/$0.40.
  const QWEN_ENDPOINTS = [
    { provider_name: "DeepInfra", tag: "deepinfra/fp8/flex", service_tier: "flex", quantization: "fp8", pricing: { prompt: "0.000000288", completion: "0.00000032" } },
    { provider_name: "DeepInfra", tag: "deepinfra/fp8", service_tier: null, quantization: "fp8", pricing: { prompt: "0.00000036", completion: "0.0000004" } },
  ];
  const MISTRAL_ENDPOINTS = [
    { provider_name: "DeepInfra", tag: "deepinfra/fp8/flex", service_tier: "flex", quantization: "fp8", pricing: { prompt: "0.00000006", completion: "0.00000016" } },
    { provider_name: "DeepInfra", tag: "deepinfra/fp8", service_tier: null, quantization: "fp8", pricing: { prompt: "0.000000075", completion: "0.0000002" } },
    { provider_name: "Parasail", tag: "parasail/bf16", service_tier: null, quantization: "bf16", pricing: { prompt: "0.00000009", completion: "0.0000003" } },
    { provider_name: "DeepInfra", tag: "deepinfra/fp8/priority", service_tier: "priority", quantization: "fp8", pricing: { prompt: "0.0000001125", completion: "0.0000003" } },
  ];
  function stubEndpoints(id: string, endpoints: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ data: { id, endpoints } }) })),
    );
  }
  function entry(over: Partial<ModelRegistryEntry>): ModelRegistryEntry {
    return {
      id: "qwen-2.5-72b-instruct",
      provider: "openrouter",
      endpoint: "https://openrouter.ai/api/v1/chat/completions",
      model_string: "qwen/qwen-2.5-72b-instruct",
      tier: "open-weight-hosted",
      open_weights: true,
      host: "deepinfra/fp8",
      service_tier: "default",
      quantization: "fp8",
      listed_tiers: ["deepinfra/fp8/flex"],
      ...over,
    };
  }

  it("fails loudly when a bare provider host matches more than one endpoint, never taking the first listed", async () => {
    stubEndpoints("qwen/qwen-2.5-72b-instruct", QWEN_ENDPOINTS);
    await expect(buildPriceSnapshotFromOpenRouter([entry({ host: "deepinfra", listed_tiers: [] })], "t", "t")).rejects.toThrow(
      /qwen-2\.5-72b-instruct.*"deepinfra" matches 2 endpoints.*deepinfra\/fp8\/flex.*deepinfra\/fp8/s,
    );
  });

  it("prices the exact standard endpoint and records it, with every tier endpoint under it at its own price", async () => {
    stubEndpoints("mistralai/mistral-small-3.2-24b-instruct", MISTRAL_ENDPOINTS);
    const { snapshot, unmatched } = await buildPriceSnapshotFromOpenRouter(
      [
        entry({
          id: "mistral-small-3.2-24b-deepinfra",
          model_string: "mistralai/mistral-small-3.2-24b-instruct",
          listed_tiers: ["deepinfra/fp8/flex", "deepinfra/fp8/priority"],
        }),
      ],
      "t",
      "t",
    );
    expect(unmatched).toEqual([]);
    expect(snapshot.entries[0]).toEqual({
      model_id: "mistral-small-3.2-24b-deepinfra",
      price_in_usd_per_1m: "0.075",
      price_out_usd_per_1m: "0.2",
      endpoint_tag: "deepinfra/fp8",
      tiers: [
        { tag: "deepinfra/fp8/flex", service_tier: "flex", price_in_usd_per_1m: "0.06", price_out_usd_per_1m: "0.16" },
        { tag: "deepinfra/fp8/priority", service_tier: "priority", price_in_usd_per_1m: "0.1125", price_out_usd_per_1m: "0.3" },
      ],
    });
  });

  it("fails loudly when the provider has added, removed or renamed a tier under the constituent: re-measure before pricing", async () => {
    stubEndpoints("qwen/qwen-2.5-72b-instruct", [
      ...QWEN_ENDPOINTS,
      { provider_name: "DeepInfra", tag: "deepinfra/fp8/priority", service_tier: "priority", quantization: "fp8", pricing: { prompt: "0.00000054", completion: "0.0000006" } },
    ]);
    await expect(buildPriceSnapshotFromOpenRouter([entry({})], "t", "t")).rejects.toThrow(
      /qwen-2\.5-72b-instruct.*purchase path changed.*deepinfra\/fp8\/priority.*re-measure/s,
    );
  });

  it("fails loudly when an OpenRouter entry declares no listed tiers", async () => {
    stubEndpoints("qwen/qwen-2.5-72b-instruct", QWEN_ENDPOINTS);
    const undeclared = entry({});
    delete undeclared.listed_tiers;
    await expect(buildPriceSnapshotFromOpenRouter([undeclared], "t", "t")).rejects.toThrow(/declares no listed_tiers/);
  });

  it("fails loudly when the pinned endpoint now serves another numeric format than declared", async () => {
    stubEndpoints("qwen/qwen-2.5-72b-instruct", QWEN_ENDPOINTS);
    await expect(buildPriceSnapshotFromOpenRouter([entry({ quantization: "bf16" })], "t", "t")).rejects.toThrow(
      /purchase path changed.*fp8.*bf16/s,
    );
  });

  it("still reports an exact tag nobody lists as unmatched, never pricing a neighbour", async () => {
    stubEndpoints("qwen/qwen-2.5-72b-instruct", QWEN_ENDPOINTS);
    const { snapshot, unmatched } = await buildPriceSnapshotFromOpenRouter(
      [entry({ host: "deepinfra/bf16" }), entry({ id: "qwen-ok" })],
      "t",
      "t",
    );
    expect(unmatched).toEqual(["qwen-2.5-72b-instruct"]);
    expect(snapshot.entries.map((e) => e.model_id)).toEqual(["qwen-ok"]);
  });
});

describe("buildPriceSnapshotFromLiteLLM", () => {
  it("matches an xAI entry via the xai/ prefix, without needing model_string itself prefixed", async () => {
    // Found live, 2026-09-08, admitting grok-4.6: LiteLLM keys every xAI entry "xai/<model>"
    // (unlike Anthropic/OpenAI/Google, which match bare) — registryEntry.model_string must stay
    // the bare form regardless, since it's also the real API call's own "model" field, which
    // xAI's endpoint doesn't understand the "xai/" prefix for.
    const registry: ModelRegistryEntry[] = [
      {
        id: "grok-4.6",
        provider: "xai",
        endpoint: "https://api.x.ai/v1/chat/completions",
        model_string: "grok-4.6",
        tier: "frontier",
        open_weights: false,
        host: "xai",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          "xai/grok-4.6": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000006 },
        }),
      })),
    );

    const { snapshot: result, unmatched } = await buildPriceSnapshotFromLiteLLM(registry, "t", "t");
    expect(unmatched).toEqual([]);
    expect(result.entries[0].price_in_usd_per_1m).toBe("2");
    expect(result.entries[0].price_out_usd_per_1m).toBe("6");
  });

  it("captures a published cache_read_input_token_cost as price_cached_in_usd_per_1m", async () => {
    // Found live, 2026-09-13: gemini-3.1-pro-preview's real LiteLLM entry carries
    // cache_read_input_token_cost: 2e-7 ($0.20/1M) — confirmed to match Google's own published
    // rate at ai.google.dev/gemini-api/docs/pricing exactly. Sourced the same way as
    // input/output: real, live, no hand-picked number.
    const registry: ModelRegistryEntry[] = [
      {
        id: "gemini-3.1-pro-preview",
        provider: "google",
        endpoint: "https://generativelanguage.googleapis.com",
        model_string: "gemini-3.1-pro-preview",
        tier: "frontier",
        open_weights: false,
        host: "google",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          "gemini-3.1-pro-preview": {
            input_cost_per_token: 0.000002,
            output_cost_per_token: 0.000012,
            cache_read_input_token_cost: 2e-7,
          },
        }),
      })),
    );

    const { snapshot: result } = await buildPriceSnapshotFromLiteLLM(registry, "t", "t");
    expect(result.entries[0].price_cached_in_usd_per_1m).toBe("0.2");
  });

  it("omits price_cached_in_usd_per_1m entirely when the source has no cache rate for this model", async () => {
    // Absent, not defaulted to "0" or to the input rate — a model with no published cache rate
    // must leave cached_input genuinely unpriced downstream, never guessed.
    const registry: ModelRegistryEntry[] = [
      {
        id: "grok-4.6",
        provider: "xai",
        endpoint: "https://api.x.ai/v1/chat/completions",
        model_string: "grok-4.6",
        tier: "frontier",
        open_weights: false,
        host: "xai",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          "xai/grok-4.6": { input_cost_per_token: 0.000002, output_cost_per_token: 0.000006 },
        }),
      })),
    );

    const { snapshot: result } = await buildPriceSnapshotFromLiteLLM(registry, "t", "t");
    expect(result.entries[0]).not.toHaveProperty("price_cached_in_usd_per_1m");
  });

  it("still reports a genuinely absent model as unmatched, never fabricating a price", async () => {
    const registry: ModelRegistryEntry[] = [
      {
        id: "nowhere",
        provider: "xai",
        endpoint: "https://api.x.ai/v1/chat/completions",
        model_string: "grok-nonexistent",
        tier: "frontier",
        open_weights: false,
        host: "xai",
      },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const { unmatched } = await buildPriceSnapshotFromLiteLLM(registry, "t", "t");
    expect(unmatched).toEqual(["nowhere"]);
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
