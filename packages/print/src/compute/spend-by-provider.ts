import type { ModelRegistryEntry, RunRecord } from "@touchstone/sdk";
import { D, callCost, type DecimalValue } from "../decimal.js";
import type { ModelPrice } from "./class-cost.js";

/** Decimal-string USD, keyed by provider (e.g. "anthropic", "google") — sorted by key so the
 * written file is stable and diffable. */
export type ProviderSpend = Record<string, string>;

/**
 * Real total USD actually billed today, grouped by provider — added 2026-09-27, after a real,
 * predictable-nine-days-in-advance Anthropic credit exhaustion (see docs/methodology.md's
 * billing-exhaustion disclosure) went unnoticed until it started failing calls. Deliberately a
 * different number from Print.cost_of_production_usd: that figure is the published,
 * methodology-defined cost (mean cost across passing instances only, per computeClassCost); this
 * sums every attempt's real usage, retries and eventually-failed instances included, because a
 * retried call still spends real provider tokens even though it contributes nothing to the
 * published cost — the number an operator needs to estimate runway from a top-up size is what was
 * actually charged, not what the methodology later chooses to publish.
 *
 * A billing-exhausted call itself contributes nothing here, correctly: the provider rejected it
 * before billing any tokens, so it produced no RunRecord at all (see harness/orchestrator.ts's
 * InstanceOutcome — an infra failure produces no record).
 */
export function computeSpendByProvider(
  records: RunRecord[],
  registry: ModelRegistryEntry[],
  pricesByModelId: Map<string, ModelPrice>,
): ProviderSpend {
  const providerById = new Map(registry.map((r) => [r.id, r.provider]));
  const totals = new Map<string, DecimalValue>();
  for (const record of records) {
    const provider = providerById.get(record.model_id);
    const price = pricesByModelId.get(record.model_id);
    if (!provider || !price) continue; // Deregistered or unpriced model — nothing to attribute real spend to.
    const cost = callCost(
      record.usage.input,
      record.usage.output + record.usage.reasoning,
      price.price_in_usd_per_1m,
      price.price_out_usd_per_1m,
      record.usage.cached_input,
      price.price_cached_in_usd_per_1m,
    );
    totals.set(provider, (totals.get(provider) ?? new D(0)).plus(cost));
  }

  const result: ProviderSpend = {};
  for (const [provider, total] of [...totals.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    result[provider] = total.toString();
  }
  return result;
}
