import { D, sum, type DecimalValue } from "../decimal.js";
import { callCostOf, listPriceAt } from "./class-cost.js";
import type { ModelInput } from "./index.js";

/** A gap between what a constituent was billed and its list price larger than this, either way, is flagged (rules-2026-11-20). */
export const PRICE_CHECK_TOLERANCE = "0.01";

const STANDARD_TIERS = new Set(["default", "standard"]);

export interface PriceCheckRow {
  model_id: string;
  /** Every recorded call, every attempt: what the print's run actually bought. */
  calls: number;
  /** Calls whose response reported a billed figure. */
  calls_billed: number;
  /** What those calls were billed, summed; null when no response reported a billed figure (the invoice reconciles those, methodology §7). */
  billed_usd: string | null;
  /** The same calls at the list price of the tier each response reports; null with billed_usd. */
  listed_usd: string | null;
  /** billed / listed - 1, as a decimal string; null with billed_usd. */
  gap: string | null;
  /** Calls per tier name the responses report ("none" when a response names no tier). */
  tiers_served: Record<string, number>;
  /** Calls served on a tier other than the constituent's declared one: priced correctly, but off its declared purchase path. */
  calls_off_declared_tier: number;
  flagged: boolean;
  reasons: string[];
}

export interface PriceCheck {
  tolerance: string;
  flagged: boolean;
  rows: PriceCheckRow[];
}

function pct(value: DecimalValue): string {
  return value.times(100).abs().toDecimalPlaces(2).toString();
}

/**
 * The daily reconciliation of priced cost against billed cost (docs/methodology.md, rules-2026-11-20): for each constituent, what its calls were
 * billed, from their own responses, against the same calls at the list price of the tier each response reports. The billed figure is the price;
 * this is the cross-check that a list price, a tier or a pin has moved under a constituent. Flags a gap over 1% either way, a call on a tier with no
 * list price, and calls that report no billed figure from a constituent whose responses otherwise do.
 */
export function computePriceCheck(
  models: ModelInput[],
  declaredTier: Map<string, string>,
  tolerance: string = PRICE_CHECK_TOLERANCE,
): PriceCheck {
  const rows = models.map((model): PriceCheckRow => {
    const reasons: string[] = [];
    const tiers_served: Record<string, number> = {};
    const declared = declaredTier.get(model.model_id);
    let offDeclared = 0;
    const missingTierPrices = new Set<string>();
    for (const r of model.records) {
      const tier = r.service_tier ?? "none";
      tiers_served[tier] = (tiers_served[tier] ?? 0) + 1;
      const standard = r.service_tier === undefined || r.service_tier === null || STANDARD_TIERS.has(r.service_tier);
      if (!standard && model.tierPrices?.[r.service_tier as string] === undefined) missingTierPrices.add(r.service_tier as string);
      const onDeclared = standard ? declared === undefined || STANDARD_TIERS.has(declared) : r.service_tier === declared;
      if (!onDeclared) offDeclared++;
    }
    for (const tier of missingTierPrices) reasons.push(`tier "${tier}" has no list price in the snapshot`);

    const billedCalls = model.records.filter((r) => r.billed_usd !== undefined);
    if (billedCalls.length === 0) {
      return {
        model_id: model.model_id,
        calls: model.records.length,
        calls_billed: 0,
        billed_usd: null,
        listed_usd: null,
        gap: null,
        tiers_served,
        calls_off_declared_tier: offDeclared,
        flagged: reasons.length > 0,
        reasons,
      };
    }
    if (billedCalls.length < model.records.length) {
      reasons.push(`${model.records.length - billedCalls.length} of ${model.records.length} calls report no billed figure`);
    }
    const billed = sum(billedCalls.map((r) => new D(r.billed_usd as string)));
    const listed = sum(billedCalls.map((r) => callCostOf(r, { price: listPriceAt(model, r.service_tier) })));
    const gap = listed.isZero() ? new D(0) : billed.dividedBy(listed).minus(1);
    if (gap.abs().greaterThan(tolerance)) {
      reasons.push(`billed ${pct(gap)}% ${gap.isPositive() ? "above" : "below"} the list price of the tiers served`);
    }
    return {
      model_id: model.model_id,
      calls: model.records.length,
      calls_billed: billedCalls.length,
      billed_usd: billed.toString(),
      listed_usd: listed.toString(),
      gap: gap.toString(),
      tiers_served,
      calls_off_declared_tier: offDeclared,
      flagged: reasons.length > 0,
      reasons,
    };
  });
  return { tolerance, flagged: rows.some((r) => r.flagged), rows };
}
