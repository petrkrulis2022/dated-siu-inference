import { callCost, sum, type DecimalValue } from "../decimal.js";
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
 */
export function computeCostOfProduction(models: ModelInput[]): DecimalValue {
  const perModelCosts = models.map((model) =>
    sum(
      model.records.map((record) =>
        callCost(
          record.usage.input,
          record.usage.output,
          model.price.price_in_usd_per_1m,
          model.price.price_out_usd_per_1m,
        ),
      ),
    ),
  );
  return sum(perModelCosts);
}
