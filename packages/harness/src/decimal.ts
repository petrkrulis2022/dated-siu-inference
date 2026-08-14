import { Decimal } from "decimal.js";

/** cost = tokens * pricePerMillion / 1,000,000, computed exactly — never plain float arithmetic. */
export function tokenCost(tokens: number, pricePerMillionUsd: string): string {
  return new Decimal(tokens).times(pricePerMillionUsd).dividedBy(1_000_000).toString();
}

export function sumCosts(costs: string[]): string {
  return costs.reduce((acc: Decimal, c) => acc.plus(c), new Decimal(0)).toString();
}

/** Relative difference |a - b| / b, as a decimal string. Used by reconcile's tolerance check. */
export function relativeDelta(a: string, b: string): string {
  const diff = new Decimal(a).minus(b).abs();
  const base = new Decimal(b).abs();
  if (base.isZero()) {
    return diff.isZero() ? "0" : "1";
  }
  return diff.dividedBy(base).toString();
}

export function decimalLessThanOrEqual(a: string, b: string): boolean {
  return new Decimal(a).lessThanOrEqualTo(new Decimal(b));
}
