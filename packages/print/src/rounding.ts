import { D, type DecimalValue } from "./decimal.js";

/**
 * Publication rounding rules. build1-spec.md §6: "All money maths in integer minor units or
 * decimal strings — never floats. Rounding rules stated in the methodology, applied at
 * publication only."
 *
 * Every intermediate value in the pipeline stays at full precision; these functions are
 * applied once, at the point a value is written into the print body.
 */
export interface RoundingRules {
  dated_siu_dp: number;
  basket_cost_dp: number;
  usd_per_siu_dp: number;
  spread_dp: number;
  siu_per_usd_dp: number;
  mode: "ROUND_HALF_UP";
  siu_per_usd_mode: "ROUND_DOWN";
  notes?: string;
}

export const DEFAULT_ROUNDING: RoundingRules = {
  dated_siu_dp: 4,
  // 6dp, deliberately finer than the 4dp headline figures. At 4dp a reader cannot reproduce
  // the published Dated SIU from the published basket costs and weights — the rounding error
  // across models is large enough to shift the last digit. Reproducibility from published
  // values is the claim the whole index rests on, so the working figures carry more digits
  // than the headline.
  basket_cost_dp: 6,
  usd_per_siu_dp: 4,
  spread_dp: 4,
  siu_per_usd_dp: 1,
  mode: "ROUND_HALF_UP",
  // ROUND_DOWN, not half-up: "SIU per $1" tells a buyer how much work a dollar buys, so
  // truncating is the direction that never overstates what they get for their money.
  siu_per_usd_mode: "ROUND_DOWN",
  notes:
    "Applied at publication only; all intermediate arithmetic is full-precision decimal. " +
    "basket_cost carries more decimal places than dated_siu so the published print is " +
    "reproducible from its own published figures. siu_per_usd truncates so it never " +
    "overstates the work a dollar buys.",
};

export function roundHalfUp(value: DecimalValue, dp: number): string {
  return value.toFixed(dp, D.ROUND_HALF_UP);
}

export function roundDown(value: DecimalValue, dp: number): string {
  return value.toFixed(dp, D.ROUND_DOWN);
}

/** Renders a ratio as a signed whole-percent string, e.g. 1.0156 -> "+102%". */
export function formatSpreadPercent(ratio: string): string {
  const pct = new D(ratio).times(100).toFixed(0, D.ROUND_HALF_UP);
  return new D(pct).isNegative() ? `${pct}%` : `+${pct}%`;
}

/** Renders a delta ratio as a signed percent with one decimal place, e.g. -0.1233 -> "-12.3%". */
export function formatDeltaPercent(ratio: string): string {
  const pct = new D(ratio).times(100).toFixed(1, D.ROUND_HALF_UP);
  return new D(pct).isNegative() ? `${pct}%` : `+${pct}%`;
}
