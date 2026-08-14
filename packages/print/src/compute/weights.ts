import { D, sum, type DecimalValue } from "../decimal.js";

export type WeightSource = "routed-market-share" | "equal";

export interface ResolvedWeights {
  source: WeightSource;
  weights: Map<string, DecimalValue>;
}

/**
 * Index weights over the qualifying set — build1-spec.md §6.3.
 *
 * "Observed routed-market share across the qualifying set, normalised. If share data is
 * unavailable, equal weights, and the print declares which was used."
 *
 * Normalisation is over the QUALIFYING set only: a model that failed a class has no basket
 * cost, so its share must be redistributed across the models that do, not silently dropped
 * (which would leave the weights summing to less than 1 and quietly deflate the index).
 *
 * Falls back to equal weights — and says so in the returned `source`, which the print
 * publishes — when no share data covers the qualifying set, or when the shares that do
 * cover it sum to zero.
 */
export function resolveWeights(
  qualifyingModelIds: string[],
  observedShares?: Map<string, string>,
): ResolvedWeights {
  if (qualifyingModelIds.length === 0) {
    throw new Error(
      "Cannot resolve weights: the qualifying set is empty (no model has a basket cost).",
    );
  }

  if (observedShares) {
    const present = qualifyingModelIds.filter((id) => observedShares.has(id));
    if (present.length === qualifyingModelIds.length) {
      const values = qualifyingModelIds.map((id) => new D(observedShares.get(id) as string));
      const total = sum(values);
      // greaterThan(0), NOT isPositive(): decimal.js reports isPositive() === true for zero,
      // so an isPositive() guard would let a zero total through, divide 0/0, and produce NaN
      // weights — a garbage index that would then be signed and published.
      if (total.greaterThan(0)) {
        const weights = new Map<string, DecimalValue>();
        qualifyingModelIds.forEach((id, i) => {
          weights.set(id, values[i].dividedBy(total));
        });
        return { source: "routed-market-share", weights };
      }
    }
  }

  const equal = new D(1).dividedBy(qualifyingModelIds.length);
  const weights = new Map<string, DecimalValue>();
  for (const id of qualifyingModelIds) {
    weights.set(id, equal);
  }
  return { source: "equal", weights };
}

/** Dated SIU = Σ_models share × basket_cost — build1-spec.md §6.4. */
export function computeDatedSiu(
  basketCosts: Map<string, DecimalValue>,
  weights: Map<string, DecimalValue>,
): DecimalValue {
  const terms: DecimalValue[] = [];
  for (const [modelId, weight] of weights) {
    const cost = basketCosts.get(modelId);
    if (cost === undefined) {
      throw new Error(
        `Weight assigned to "${modelId}", which has no basket cost — weights must cover the qualifying set exactly.`,
      );
    }
    terms.push(weight.times(cost));
  }
  return sum(terms);
}
