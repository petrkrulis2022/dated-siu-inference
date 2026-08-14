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

/** Cost of one call: (input ÷ 1e6 × price_in) + (output ÷ 1e6 × price_out) — build1-spec.md §6.1. */
export function callCost(
  inputTokens: number,
  outputTokens: number,
  priceInPerMillion: string,
  priceOutPerMillion: string,
): DecimalValue {
  return new D(inputTokens)
    .dividedBy(MILLION)
    .times(priceInPerMillion)
    .plus(new D(outputTokens).dividedBy(MILLION).times(priceOutPerMillion));
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
