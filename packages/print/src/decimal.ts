import { Decimal as GlobalDecimal } from "decimal.js";

/**
 * A package-scoped Decimal constructor, NOT the global one.
 *
 * Two machines must compute byte-identical prints from the same inputs, and decimal.js's
 * precision is a constructor-level setting. Using the global `Decimal` would mean any other
 * package in the process calling `Decimal.set(...)` could silently change this package's
 * arithmetic — and therefore the published number — with no test failing anywhere. A cloned
 * constructor pins the configuration to this module.
 *
 * 40 significant digits is far more than the ~10 needed by any real print, so intermediate
 * division (spread ratios, SIU-per-dollar reciprocals) never loses precision that could
 * surface after rounding.
 */
export const D = GlobalDecimal.clone({
  precision: 40,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type DecimalValue = InstanceType<typeof D>;

const MILLION = new D(1_000_000);

/**
 * Cost of one call: (input ÷ 1e6 × price_in) + (output ÷ 1e6 × price_out) — build1-spec.md §6.1
 * — plus (cached ÷ 1e6 × price_cached) when both a nonzero cached token count and a published
 * cached rate are given. cachedTokens defaults to 0 and cachedPricePerMillion is optional so
 * every existing call site (and any model with no published cache rate) is unaffected; a model
 * with real cached_input usage but no cachedPricePerMillion still prices only input+output —
 * cached tokens go unpriced for it rather than at a guessed rate.
 */
export function callCost(
  inputTokens: number,
  outputTokens: number,
  priceInPerMillion: string,
  priceOutPerMillion: string,
  cachedTokens = 0,
  cachedPricePerMillion?: string,
): DecimalValue {
  let total = new D(inputTokens)
    .dividedBy(MILLION)
    .times(priceInPerMillion)
    .plus(new D(outputTokens).dividedBy(MILLION).times(priceOutPerMillion));
  if (cachedTokens > 0 && cachedPricePerMillion != null) {
    total = total.plus(new D(cachedTokens).dividedBy(MILLION).times(cachedPricePerMillion));
  }
  return total;
}

export function sum(values: DecimalValue[]): DecimalValue {
  return values.reduce((acc: DecimalValue, v) => acc.plus(v), new D(0));
}

export function mean(values: DecimalValue[]): DecimalValue {
  if (values.length === 0) {
    throw new Error("mean() of an empty set is undefined — the caller must handle this case.");
  }
  return sum(values).dividedBy(values.length);
}

/**
 * The middle value of the qualifying set (linear interpolation at an even count) — a published
 * diagnostic only, never the primary statistic (docs/methodology.md's Aggregation section, the
 * 2026-09-26 methodology fix). Unweighted: it exists to show how sensitive the mean is to a
 * single constituent, which weighting would obscure.
 */
export function median(values: DecimalValue[]): DecimalValue {
  if (values.length === 0) {
    throw new Error("median() of an empty set is undefined — the caller must handle this case.");
  }
  const sorted = [...values].sort((a, b) => a.comparedTo(b));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return sorted[mid - 1].plus(sorted[mid]).dividedBy(2);
}
