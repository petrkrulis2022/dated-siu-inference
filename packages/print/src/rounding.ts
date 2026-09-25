import { D, type DecimalValue } from "./decimal.js";

/**
 * Publication rounding rules. build1-spec.md §6: "All money maths in integer minor units or
 * decimal strings — never floats. Rounding rules stated in the methodology, applied at
 * publication only."
 *
 * Every intermediate value in the pipeline stays at full precision; these functions are
 * applied once, at the point a value is written into the print body.
 */
/**
 * `dated_siu` rounds to a fixed number of SIGNIFICANT figures, not a fixed number of decimal
 * places — every other field below still rounds to a fixed decimal-place count. Found live,
 * 2026-09-25: a fixed 4 decimal places is only ~2 significant figures at Commodity SIU's price
 * level (~$0.0014), coarser than its real day-to-day movement, so 23 straight days published the
 * identical "0.0014" even though the true value moved every day. The same failure mode already
 * reaches the blended headline as its own price falls (see docs/methodology.md's Rounding
 * section) — a fixed decimal-place count would keep needing this fix again; significant figures
 * scale with the price and don't. Exactly one of `dated_siu_dp` (the old rule, still present so a
 * historical print's own signed `rounding` object stays a faithful, typed record of the rule it
 * actually used) or `dated_siu_sig_figs` (the current rule) is ever set on a given print — never
 * both. See `roundDatedSiu` below for which function each one selects.
 */
export type DatedSiuRounding =
  | { dated_siu_dp: number; dated_siu_sig_figs?: undefined }
  | { dated_siu_dp?: undefined; dated_siu_sig_figs: number };

export type RoundingRules = DatedSiuRounding & {
  basket_cost_dp: number;
  usd_per_siu_dp: number;
  spread_dp: number;
  siu_per_usd_dp: number;
  mode: "ROUND_HALF_UP";
  siu_per_usd_mode: "ROUND_DOWN";
  notes?: string;
};

export const DEFAULT_ROUNDING: RoundingRules = {
  dated_siu_sig_figs: 4,
  // 6dp, deliberately finer than dated_siu's own precision at any price level it has reached or
  // is likely to. At 4dp a reader cannot reproduce the published Dated SIU from the published
  // basket costs and weights — the rounding error across models is large enough to shift the
  // last digit. Reproducibility from published values is the claim the whole index rests on, so
  // the working figures carry more digits than the headline.
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
    "dated_siu rounds to significant figures, not a fixed decimal-place count, so its precision " +
    "scales with the price rather than being lost as it falls (found live, 2026-09-25 — see " +
    "docs/methodology.md's Rounding section). basket_cost carries more decimal places than " +
    "dated_siu needs at any price level so the published print stays reproducible from its own " +
    "published figures. siu_per_usd truncates so it never overstates the work a dollar buys.",
};

export function roundHalfUp(value: DecimalValue, dp: number): string {
  return value.toFixed(dp, D.ROUND_HALF_UP);
}

export function roundDown(value: DecimalValue, dp: number): string {
  return value.toFixed(dp, D.ROUND_DOWN);
}

/**
 * Rounds to a fixed number of significant figures, always showing exactly that many — a
 * trailing zero that `toSignificantDigits().toFixed()` alone would silently drop (e.g. "0.0014"
 * instead of "0.001400") is itself real information: it says the 4th significant digit was
 * checked and is a zero, not merely omitted. `dp` is computed from the ROUNDED value's own
 * exponent (`.e`), not the input's — correct even when rounding carries into a new order of
 * magnitude (e.g. 0.099995 at 4 sig figs is 0.1000, not 0.09999 padded).
 */
export function roundSignificantFigures(value: DecimalValue, sigFigs: number): string {
  const rounded = value.toSignificantDigits(sigFigs, D.ROUND_HALF_UP);
  if (rounded.isZero()) return rounded.toFixed(0);
  const dp = Math.max(0, sigFigs - 1 - rounded.e);
  return rounded.toFixed(dp);
}

/** Applies whichever of `dated_siu_dp`/`dated_siu_sig_figs` a given `RoundingRules` object
 * actually carries — the one place both branches of `DatedSiuRounding` are read together, so a
 * historical print's own (still fixed-decimal-place) `rounding` object continues to round exactly
 * as it originally did if it were ever recomputed, while `DEFAULT_ROUNDING` and any future print
 * use the significant-figures rule. */
export function roundDatedSiu(value: DecimalValue, rounding: RoundingRules): string {
  return rounding.dated_siu_sig_figs !== undefined
    ? roundSignificantFigures(value, rounding.dated_siu_sig_figs)
    : roundHalfUp(value, rounding.dated_siu_dp);
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
