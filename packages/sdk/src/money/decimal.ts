import { Decimal as GlobalDecimal } from "decimal.js";

/**
 * A package-scoped Decimal constructor, NOT the global one, NOT an import of
 * `@datum/print`'s clone (same clone config, deliberately duplicated).
 *
 * `@datum/print` depends on `@datum/sdk`, never the reverse — importing print's `D` here
 * would create a dependency cycle. decimal.js's precision is a constructor-level setting, so
 * cloning pins this module's arithmetic against any other package in the process calling
 * `Decimal.set(...)`.
 *
 * `toExpNeg`/`toExpPos` at ±9e15 mean `toFixed`/`toString` never emit exponential notation —
 * exponential notation would fail every schema's `decimalString` pattern
 * (`^-?[0-9]+(\.[0-9]+)?$`).
 */
export const D = GlobalDecimal.clone({
  precision: 40,
  toExpNeg: -9e15,
  toExpPos: 9e15,
});

export type DecimalValue = InstanceType<typeof D>;

/** Mirrors packages/print/src/rounding.ts's roundHalfUp, duplicated for the same
 * no-cross-package-import reason as `D` itself. */
export function roundHalfUp(value: DecimalValue, dp: number): string {
  return value.toFixed(dp, D.ROUND_HALF_UP);
}
