import { D, type DecimalValue } from "@touchstone/sdk";

/** Money is a decimal string of digits, never a JS number and never scientific notation (invariant 4). */
const USD = /^\d+(\.\d+)?$/;

/** Parses a USD amount. Throws on a number, a negative, an exponent or anything else that is not plain decimal digits. */
export function parseUsd(value: unknown, label: string): DecimalValue {
  if (typeof value !== "string" || !USD.test(value)) {
    throw new TypeError(
      `${label} must be a plain decimal string such as "0.0125", got ${typeof value === "string" ? JSON.stringify(value) : typeof value}`,
    );
  }
  return new D(value);
}

/** USD at the ledger's precision: six decimals, the figure the provider bills to. */
export const fmtUsd = (value: DecimalValue): string => value.toFixed(6);
