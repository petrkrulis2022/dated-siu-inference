import { D, type DecimalValue } from "../decimal.js";

export interface ExchangeRateRow {
  model_id: string;
  usd_per_siu?: DecimalValue;
  spread_to_index?: DecimalValue;
  siu_per_usd?: DecimalValue;
  excluded_reason?: string;
}

/**
 * Per-model exchange rates — build1-spec.md §6.5: "USD per SIU, spread to index
 * (basket ÷ print − 1), SIU per $1."
 *
 * A model with no basket cost gets a gap row carrying its exclusion reason rather than being
 * dropped from the table (§6.2: "appears in the table with a gap") — a reader needs to see
 * that the model was measured and failed, not silently not measured at all.
 */
export function computeExchangeRateTable(
  basketCosts: Map<string, DecimalValue | undefined>,
  exclusionReasons: Map<string, string>,
  datedSiu: DecimalValue,
): ExchangeRateRow[] {
  const rows: ExchangeRateRow[] = [];

  for (const [modelId, cost] of basketCosts) {
    if (cost === undefined) {
      rows.push({
        model_id: modelId,
        excluded_reason: exclusionReasons.get(modelId) ?? "no defined basket cost",
      });
      continue;
    }
    if (cost.isZero()) {
      // Guard rather than emit Infinity for SIU-per-dollar. A zero-cost basket means the
      // measurement is broken (free inference is not a thing the index can price), so this
      // should surface as an excluded row, not as a nonsense rate.
      rows.push({ model_id: modelId, excluded_reason: "basket cost computed as zero" });
      continue;
    }
    rows.push({
      model_id: modelId,
      usd_per_siu: cost,
      spread_to_index: cost.dividedBy(datedSiu).minus(1),
      siu_per_usd: new D(1).dividedBy(cost),
    });
  }

  return rows;
}
