import { Decimal } from "decimal.js";

/**
 * Converts a per-token USD price into a per-1M-token USD price, as a decimal string.
 * Accepts either a decimal string (OpenRouter's format) or a JSON number (LiteLLM's
 * format) — decimal.js parses both exactly, including exponential notation like "2.5e-7",
 * without the float-multiplication drift plain `n * 1_000_000` risks.
 */
export function perTokenToPer1M(perToken: string | number): string {
  return new Decimal(perToken).times(1_000_000).toString();
}

/** True when `a` is strictly less than `b`, comparing as exact decimals, not floats. */
export function decimalLessThan(a: string, b: string): boolean {
  return new Decimal(a).lessThan(new Decimal(b));
}

/** Converts a raw JSON number to its canonical decimal string, without float arithmetic. */
export function jsonNumberToDecimalString(value: number): string {
  return new Decimal(value).toString();
}

/** Divides two values (raw numbers or decimal strings) exactly, returning a decimal string. */
export function decimalDivide(numerator: string | number, denominator: string | number): string {
  return new Decimal(numerator).dividedBy(new Decimal(denominator)).toString();
}
