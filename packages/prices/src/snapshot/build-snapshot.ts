import type { ModelRegistryEntry, PriceSnapshot } from "@touchstone/sdk";
import { perTokenToPer1M, decimalLessThan } from "../decimal.js";
import { fetchOpenRouterEndpoints, fetchOpenRouterModels } from "../sources/openrouter.js";
import { fetchLiteLLMPrices, type LiteLLMPriceMap } from "../sources/litellm.js";

export interface SnapshotBuildResult {
  snapshot: PriceSnapshot;
  /** Registry ids with no price found in this source — never fabricated, always reported. */
  unmatched: string[];
}

// PriceSnapshot["entries"] is a non-empty tuple (the schema requires at least one priced
// entry) — the right type for a final snapshot, but not for an accumulator built up one
// .push() at a time starting from []. Same cast-at-construction pattern flagSubsidised below
// already uses.
type PriceEntry = PriceSnapshot["entries"][number];

function litellmLookup(map: LiteLLMPriceMap, modelString: string) {
  // LiteLLM's key naming is inconsistent with OpenRouter's slugs — some match exactly,
  // some are prefixed with "openrouter/", most aren't matchable by pattern at all. Try
  // the two patterns that are actually reliable; report anything else as unmatched
  // rather than guessing with fuzzy string similarity.
  return map[modelString] ?? map[`openrouter/${modelString}`];
}

export async function buildPriceSnapshotFromOpenRouter(
  registry: ModelRegistryEntry[],
  snapshotId: string,
  timestamp: string,
): Promise<SnapshotBuildResult> {
  const entries: PriceEntry[] = [];
  const unmatched: string[] = [];

  // Entries routed through OpenRouter need per-host pricing (fetchOpenRouterEndpoints), not
  // the generic /models catalog price. The catalog gives one aggregate price per
  // model_string — using it here would give every host-pinned entry sharing that
  // model_string the exact same price, silently erasing the provider spread the registry's
  // multi-host entries exist to demonstrate.
  const openRouterEntries = registry.filter((r) => r.provider === "openrouter");
  const otherEntries = registry.filter((r) => r.provider !== "openrouter");

  const uniqueModelStrings = [...new Set(openRouterEntries.map((r) => r.model_string))];
  const endpointsByModelString = new Map(
    await Promise.all(
      uniqueModelStrings.map(async (id) => [id, await fetchOpenRouterEndpoints(id)] as const),
    ),
  );

  for (const reg of openRouterEntries) {
    const endpoints = endpointsByModelString.get(reg.model_string) ?? [];
    const match = endpoints.find((e) => e.provider_name.toLowerCase() === reg.host.toLowerCase());
    if (!match) {
      unmatched.push(reg.id);
      continue;
    }
    entries.push({
      model_id: reg.id,
      price_in_usd_per_1m: perTokenToPer1M(match.pricing.prompt),
      price_out_usd_per_1m: perTokenToPer1M(match.pricing.completion),
    });
  }

  if (otherEntries.length > 0) {
    const models = await fetchOpenRouterModels();
    const byId = new Map(models.map((m) => [m.id, m]));
    for (const reg of otherEntries) {
      const match = byId.get(reg.model_string);
      if (!match) {
        unmatched.push(reg.id);
        continue;
      }
      entries.push({
        model_id: reg.id,
        price_in_usd_per_1m: perTokenToPer1M(match.pricing.prompt),
        price_out_usd_per_1m: perTokenToPer1M(match.pricing.completion),
      });
    }
  }

  return {
    snapshot: {
      snapshot_id: snapshotId,
      timestamp,
      source: "openrouter",
      entries: entries as PriceSnapshot["entries"],
    },
    unmatched,
  };
}

export async function buildPriceSnapshotFromLiteLLM(
  registry: ModelRegistryEntry[],
  snapshotId: string,
  timestamp: string,
): Promise<SnapshotBuildResult> {
  const prices = await fetchLiteLLMPrices();

  const entries: PriceEntry[] = [];
  const unmatched: string[] = [];

  for (const reg of registry) {
    const match = litellmLookup(prices, reg.model_string);
    if (!match || match.input_cost_per_token == null || match.output_cost_per_token == null) {
      unmatched.push(reg.id);
      continue;
    }
    entries.push({
      model_id: reg.id,
      price_in_usd_per_1m: perTokenToPer1M(match.input_cost_per_token),
      price_out_usd_per_1m: perTokenToPer1M(match.output_cost_per_token),
    });
  }

  return {
    snapshot: {
      snapshot_id: snapshotId,
      timestamp,
      source: "litellm",
      entries: entries as PriceSnapshot["entries"],
    },
    unmatched,
  };
}

export interface MergeSnapshotsResult {
  snapshot: PriceSnapshot;
  /** Registry ids present in both — openrouter's routed-market price wins, never overridden. */
  fromOpenRouter: string[];
  /** Registry ids with no OpenRouter presence at all (a direct-provider model, never routed
   * through OpenRouter) — litellm's list price is the only source available for these. */
  fromLiteLLM: string[];
}

/**
 * What the publish pipeline actually reads (`latestPriceSnapshotFile("merged")`). Every
 * OpenRouter-routed registry entry (the open-weight-hosted tier) keeps its real routed-market
 * price exactly as buildPriceSnapshotFromOpenRouter produced it — merging never overrides an
 * available OpenRouter price. A direct-provider entry (frontier tier — no OpenRouter presence at
 * all for models like `claude-sonnet-5`/`gpt-5.1`/`gemini-3.1-pro-preview`, which aren't routed
 * through OpenRouter) falls back to litellm's list price, the only source that has one. Found
 * live: the two frontier admissions on 2026-08-30 silently dropped out of every print
 * (`buildModelInputs`'s own "unpriced, excluded" path — correct behaviour given only the
 * openrouter snapshot was ever read) because nothing merged the litellm snapshot in at all; this
 * closes that gap rather than working around it per call site.
 */
export function mergeSnapshots(
  openrouter: PriceSnapshot,
  litellm: PriceSnapshot,
  snapshotId: string,
  timestamp: string,
): MergeSnapshotsResult {
  const litellmById = new Map(litellm.entries.map((e) => [e.model_id, e]));
  const entries: PriceEntry[] = [...openrouter.entries];
  const fromOpenRouter = openrouter.entries.map((e) => e.model_id);
  const coveredIds = new Set(fromOpenRouter);
  const fromLiteLLM: string[] = [];

  for (const [modelId, entry] of litellmById) {
    if (coveredIds.has(modelId)) continue; // openrouter's price always wins when both exist.
    entries.push(entry);
    fromLiteLLM.push(modelId);
  }

  return {
    snapshot: {
      snapshot_id: snapshotId,
      timestamp,
      source: "merged",
      entries: entries as PriceSnapshot["entries"],
    },
    fromOpenRouter,
    fromLiteLLM,
  };
}

/**
 * Flags any entry priced below `floorUsdPer1M` as subsidised, per build1-spec.md §5's
 * subsidised-supply policy. Mutates nothing — returns a new snapshot.
 */
export function flagSubsidised(snapshot: PriceSnapshot, floorUsdPer1M: string): PriceSnapshot {
  const flagged = [...snapshot.entries].map((entry) => {
    const belowFloor =
      decimalLessThan(entry.price_in_usd_per_1m, floorUsdPer1M) ||
      decimalLessThan(entry.price_out_usd_per_1m, floorUsdPer1M);
    return belowFloor ? { ...entry, subsidised: true } : entry;
  }) as PriceSnapshot["entries"];

  return { ...snapshot, entries: flagged };
}
