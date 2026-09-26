import type { Print, RunRecord } from "@touchstone/sdk";
import { D, median, type DecimalValue } from "../decimal.js";
import { DEFAULT_ROUNDING, roundDatedSiu, roundDown, roundHalfUp, type RoundingRules } from "../rounding.js";
import { computeClassCost, type ModelPrice } from "./class-cost.js";
import { computeBasketCost, type ClassWeights, type TaskClass } from "./basket-cost.js";
import { computeDatedSiu, resolveWeights } from "./weights.js";
import { computeExchangeRateTable } from "./exchange-rate.js";
import { applyAdjustment, type PolicyVariant } from "./sensitivity.js";
import { computeCostOfProduction } from "./cost-of-production.js";

export * from "./class-cost.js";
export * from "./basket-cost.js";
export * from "./weights.js";
export * from "./exchange-rate.js";
export * from "./sensitivity.js";
export * from "./cost-of-production.js";

const TASK_CLASSES: TaskClass[] = ["T1", "T2", "T3"];

/**
 * The methodology fix adopted 2026-09-26, after the Google-billing-lapse incident showed a
 * single missing constituent whipsawing the headline (mean moved 31% while the median moved
 * 0.8% over the same day, on real published print data — see docs/methodology.md's Aggregation
 * section). A model missing today because of a run/provider failure (never a registry removal —
 * that's computeConstituentChanges' own, separate concern) has its own last real, published
 * basket cost carried forward into today's blend, for up to this many days, before it is treated
 * as genuinely excluded. Fixed at 3, not configurable per print — a rule that could be tuned
 * print-by-print would invite exactly the kind of "redo until we like the answer" the revision
 * policy already forbids elsewhere.
 */
export const CARRY_FORWARD_CAP_DAYS = 3;

/** One prior day's published, qualifying basket costs — never a recomputation, only what that
 * print actually signed. Ordered most-recent-first by the caller; see loadCarryForwardHistory
 * (cli/load-inputs.ts) for how this is assembled from data/prints. */
export interface CarryForwardDay {
  date: string;
  costs: Map<string, DecimalValue>;
}

export interface ModelInput {
  model_id: string;
  price: ModelPrice;
  /** Every run record for this model, across all classes and attempts. */
  records: RunRecord[];
}

export interface PrintInput {
  version: string;
  print_id: string;
  date: string;
  status: "provisional" | "final";
  classWeights: ClassWeights;
  models: ModelInput[];
  /** Routed-market share per model id. Omit to fall back to equal weights (declared in the print). */
  observedShares?: Map<string, string>;
  floor?: { value: string; notes?: string };
  price_snapshot_ref: string;
  methodology_version: string;
  methodology_url?: string;
  /** Which entry in docs/methodology.md's Revision history table actually produced this print,
   * e.g. "rules-2026-09-25" — distinct from methodology_version (see that field's own schema
   * doc comment for why). Omitted for a caller that doesn't supply one, so no historical print
   * needs touching to add this retroactively. */
  methodology_revision?: string;
  rounding?: RoundingRules;
  sensitivityVariants?: PolicyVariant[];
  /** Prior days' own published, qualifying basket costs, most-recent-first — see
   * CarryForwardDay. Enforced against `date` above by real calendar-day arithmetic
   * (daysBetween), not array position, so a caller may safely pass more history than the cap
   * needs and rely on this function to apply the real 3-day rule. Omit entirely for a caller
   * that doesn't want carry-forward (e.g. a synthetic-fixture unit test) — every model missing
   * today is then excluded exactly as before this fix existed. */
  carryForwardHistory?: CarryForwardDay[];
}

/** Whole calendar days from `from` to `to` (both "YYYY-MM-DD"), computed via Date.UTC so this
 * is never affected by the machine's own local timezone. */
function daysBetween(from: string, to: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / msPerDay);
}

/** The nearest prior day (within CARRY_FORWARD_CAP_DAYS real calendar days of `date`) that
 * published a real, qualifying cost for this model — or undefined if none exists in range.
 * `history` may safely contain days further back than the cap; those are simply never reached
 * because daysBetween excludes them, not because the caller pre-filtered correctly. */
function findCarryForward(
  modelId: string,
  date: string,
  history: CarryForwardDay[] | undefined,
): { fromDate: string; cost: DecimalValue } | undefined {
  if (!history) return undefined;
  for (const day of history) {
    const age = daysBetween(day.date, date);
    if (age < 1 || age > CARRY_FORWARD_CAP_DAYS) continue;
    const cost = day.costs.get(modelId);
    if (cost !== undefined) return { fromDate: day.date, cost };
  }
  return undefined;
}

/** Full-precision intermediate result, before any publication rounding. */
export interface ComputedIndex {
  datedSiu: DecimalValue;
  /** The unweighted median of the same qualifying set the blend uses — a diagnostic only, never
   * the primary statistic (see decimal.ts's median doc comment). */
  medianDiagnostic: DecimalValue;
  basketCosts: Map<string, DecimalValue | undefined>;
  exclusionReasons: Map<string, string>;
  /** Models whose basket cost above is a carried-forward historical value, not one freshly
   * measured today — see CarryForwardDay and findCarryForward. */
  carriedForward: Map<string, { fromDate: string; cost: DecimalValue }>;
  weightSource: "routed-market-share" | "equal";
  weights: Map<string, DecimalValue>;
}

function computeIndex(
  models: ModelInput[],
  classWeights: ClassWeights,
  observedShares: Map<string, string> | undefined,
  date: string,
  carryForwardHistory: CarryForwardDay[] | undefined,
  variant?: PolicyVariant,
): ComputedIndex {
  const basketCosts = new Map<string, DecimalValue | undefined>();
  const exclusionReasons = new Map<string, string>();
  const carriedForward = new Map<string, { fromDate: string; cost: DecimalValue }>();

  for (const model of models) {
    const byClass = {} as Record<TaskClass, ReturnType<typeof computeClassCost>>;
    for (const cls of TASK_CLASSES) {
      const classRecords = model.records.filter((r) => r.task_class === cls);
      const price = applyAdjustment(model.price, variant?.adjust(model.model_id, cls));
      byClass[cls] = computeClassCost(classRecords, price);
    }

    const basket = computeBasketCost(byClass, classWeights);
    if (basket.cost !== undefined) {
      basketCosts.set(model.model_id, basket.cost);
      continue;
    }

    const carried = findCarryForward(model.model_id, date, carryForwardHistory);
    if (carried) {
      basketCosts.set(model.model_id, carried.cost);
      carriedForward.set(model.model_id, carried);
    } else {
      basketCosts.set(model.model_id, undefined);
      exclusionReasons.set(model.model_id, basket.undefinedReason ?? "undefined basket cost");
    }
  }

  const qualifying = [...basketCosts.entries()]
    .filter(([, cost]) => cost !== undefined)
    .map(([id]) => id);

  const { source, weights } = resolveWeights(qualifying, observedShares);
  const qualifyingCosts = new Map<string, DecimalValue>();
  for (const id of qualifying) {
    qualifyingCosts.set(id, basketCosts.get(id) as DecimalValue);
  }

  return {
    datedSiu: computeDatedSiu(qualifyingCosts, weights),
    medianDiagnostic: median([...qualifyingCosts.values()]),
    basketCosts,
    exclusionReasons,
    carriedForward,
    weightSource: source,
    weights,
  };
}

export interface ComputePrintResult {
  /** The print body — everything except `signature` and `public_key`, which signing adds. */
  body: Omit<Print, "signature" | "public_key">;
  /** Full-precision values, for callers that need to inspect before rounding. */
  computed: ComputedIndex;
}

export function computePrint(input: PrintInput): ComputePrintResult {
  const rounding = input.rounding ?? DEFAULT_ROUNDING;
  const base = computeIndex(
    input.models,
    input.classWeights,
    input.observedShares,
    input.date,
    input.carryForwardHistory,
  );

  const basket_costs = [...base.basketCosts.entries()].map(([model_id, cost]) => {
    if (cost === undefined) {
      return { model_id, excluded_reason: base.exclusionReasons.get(model_id) };
    }
    const carried = base.carriedForward.get(model_id);
    return {
      model_id,
      cost_usd: roundHalfUp(cost, rounding.basket_cost_dp),
      ...(carried ? { carried_forward_from: carried.fromDate } : {}),
    };
  }) as Print["basket_costs"];

  const weightValues = [...base.weights.entries()].map(([model_id, weight]) => ({
    model_id,
    weight: roundHalfUp(weight, rounding.basket_cost_dp),
  })) as Print["weights"]["values"];

  const exchange_rate_table = computeExchangeRateTable(
    base.basketCosts,
    base.exclusionReasons,
    base.datedSiu,
  ).map((row) =>
    row.usd_per_siu === undefined
      ? { model_id: row.model_id, excluded_reason: row.excluded_reason }
      : {
          model_id: row.model_id,
          usd_per_siu: roundHalfUp(row.usd_per_siu, rounding.usd_per_siu_dp),
          spread_to_index: roundHalfUp(row.spread_to_index as DecimalValue, rounding.spread_dp),
          siu_per_usd: roundDown(row.siu_per_usd as DecimalValue, rounding.siu_per_usd_dp),
        },
  ) as Print["exchange_rate_table"];

  const sensitivity_block = (input.sensitivityVariants ?? []).map((variant) => {
    const variantIndex = computeIndex(
      input.models,
      input.classWeights,
      input.observedShares,
      input.date,
      input.carryForwardHistory,
      variant,
    );
    return {
      policy_variant: variant.name,
      dated_siu: roundDatedSiu(variantIndex.datedSiu, rounding),
      delta: roundHalfUp(
        variantIndex.datedSiu.minus(base.datedSiu).dividedBy(base.datedSiu),
        rounding.spread_dp,
      ),
      applies_to: variant.appliesTo,
    };
  }) as Print["sensitivity_block"];

  const body: Omit<Print, "signature" | "public_key"> = {
    version: input.version,
    print_id: input.print_id,
    date: input.date,
    status: input.status,
    basket_costs,
    weights: { source: base.weightSource, values: weightValues },
    dated_siu: roundDatedSiu(base.datedSiu, rounding),
    // Diagnostic only (docs/methodology.md's Aggregation section, 2026-09-26 fix) — never the
    // primary statistic, never used by any downstream computation in this function.
    dated_siu_median_diagnostic: roundDatedSiu(base.medianDiagnostic, rounding),
    exchange_rate_table,
    sensitivity_block,
    rounding,
    // Deliberately every measured attempt for every model, not the qualifying/weighted
    // subset the index itself is built from — see cost-of-production.ts.
    cost_of_production_usd: roundHalfUp(
      computeCostOfProduction(input.models),
      rounding.usd_per_siu_dp,
    ),
    price_snapshot_ref: input.price_snapshot_ref,
    methodology_version: input.methodology_version,
  };

  if (input.methodology_url) {
    body.methodology_url = input.methodology_url;
  }

  if (input.methodology_revision) {
    body.methodology_revision = input.methodology_revision;
  }

  // Floor and market spread are omitted entirely when no measured floor is supplied, rather
  // than defaulted — build1-spec.md §5's floor needs measured GPU-seconds per basket, and an
  // invented figure in a published document is worse than an absent column.
  if (input.floor) {
    body.floor = input.floor;
    body.market_spread = roundHalfUp(
      base.datedSiu.dividedBy(new D(input.floor.value)),
      rounding.usd_per_siu_dp,
    );
  }

  return { body, computed: base };
}
