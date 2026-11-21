import { sum, type DecimalValue } from "../decimal.js";
import { callCostOf } from "./class-cost.js";
import type { ModelInput } from "./index.js";

/**
 * The aggregate cost of producing this print — build1-spec.md §7's round-2 decision: "we
 * publish what the index costs to produce."
 *
 * Deliberately NOT the same computation as the index itself: this sums every recorded
 * attempt, across every measured model, including models excluded from the reference set
 * and every retry attempt beyond the first pass. A model that failed T3 still cost real
 * tokens across three attempts per instance, and that spend is part of what the index cost
 * to produce even though it contributes nothing to the Dated SIU figure.
 *
 * Each call is priced exactly as the index prices it (class-cost.ts's callCostOf): usage.output + usage.reasoning, cached_input at its own rate
 * where published, at the list price of the tier the response reports, and from rules-2026-11-20 (`billed`) at the billed figure where the
 * response gives one; from rules-2026-11-21 (`cachedOnce`) with each cached token counted once for a provider whose usage.input includes them.
 */
export function computeCostOfProduction(models: ModelInput[], billed = false, cachedOnce = false): DecimalValue {
  const perModelCosts = models.map((model) =>
    sum(
      model.records.map((record) =>
        callCostOf(record, {
          price: model.price,
          tierPrices: model.tierPrices,
          billed,
          cachedInsideInput: cachedOnce && model.cachedInsideInput === true,
        }),
      ),
    ),
  );
  return sum(perModelCosts);
}
