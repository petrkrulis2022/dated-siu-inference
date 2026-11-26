import { Decimal as GlobalDecimal } from "decimal.js";
import { callCostUsd } from "@touchstone/sdk";

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

/**
 * Cost of one call from input and output token counts, through the one shared cost function (@touchstone/sdk's callCostUsd), for the callers
 * that estimate or convert a cost from two counts (the demo agents, the MCP server's convert tool). Cached tokens, when given, are counted as
 * apart from `inputTokens` and added at their own rate where one is published; a caller whose input count includes them uses callCostUsd with
 * its own convention instead. The print prices its calls through class-cost.ts's callCostOf.
 */
export function callCost(
  inputTokens: number,
  outputTokens: number,
  priceInPerMillion: string,
  priceOutPerMillion: string,
  cachedTokens = 0,
  cachedPricePerMillion?: string,
): DecimalValue {
  const cost = callCostUsd(
    { input: inputTokens, output: outputTokens, cached_input: cachedTokens },
    {
      priceInUsdPer1M: priceInPerMillion,
      priceOutUsdPer1M: priceOutPerMillion,
      ...(cachedPricePerMillion != null ? { priceCachedInUsdPer1M: cachedPricePerMillion } : {}),
    },
    { cachedInsideInput: false, reasoningInsideOutput: true },
  );
  return new D(cost.toString());
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
