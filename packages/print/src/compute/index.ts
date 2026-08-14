import type { Print, RunRecord } from "@datum/sdk";
import { D, type DecimalValue } from "../decimal.js";
import { DEFAULT_ROUNDING, roundDown, roundHalfUp, type RoundingRules } from "../rounding.js";
import { computeClassCost, type ModelPrice } from "./class-cost.js";
import { computeBasketCost, type ClassWeights, type TaskClass } from "./basket-cost.js";
import { computeDatedSiu, resolveWeights } from "./weights.js";
import { computeExchangeRateTable } from "./exchange-rate.js";
import { applyAdjustment, type PolicyVariant } from "./sensitivity.js";

export * from "./class-cost.js";
export * from "./basket-cost.js";
export * from "./weights.js";
export * from "./exchange-rate.js";
export * from "./sensitivity.js";

const TASK_CLASSES: TaskClass[] = ["T1", "T2", "T3"];

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
  rounding?: RoundingRules;
  sensitivityVariants?: PolicyVariant[];
}

/** Full-precision intermediate result, before any publication rounding. */
export interface ComputedIndex {
  datedSiu: DecimalValue;
  basketCosts: Map<string, DecimalValue | undefined>;
  exclusionReasons: Map<string, string>;
  weightSource: "routed-market-share" | "equal";
  weights: Map<string, DecimalValue>;
}

function computeIndex(
  models: ModelInput[],
  classWeights: ClassWeights,
  observedShares: Map<string, string> | undefined,
  variant?: PolicyVariant,
): ComputedIndex {
  const basketCosts = new Map<string, DecimalValue | undefined>();
  const exclusionReasons = new Map<string, string>();

  for (const model of models) {
    const byClass = {} as Record<TaskClass, ReturnType<typeof computeClassCost>>;
    for (const cls of TASK_CLASSES) {
      const classRecords = model.records.filter((r) => r.task_class === cls);
      const price = applyAdjustment(model.price, variant?.adjust(model.model_id, cls));
      byClass[cls] = computeClassCost(classRecords, price);
    }

    const basket = computeBasketCost(byClass, classWeights);
    basketCosts.set(model.model_id, basket.cost);
    if (basket.cost === undefined) {
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
    basketCosts,
    exclusionReasons,
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
  const base = computeIndex(input.models, input.classWeights, input.observedShares);

  const basket_costs = [...base.basketCosts.entries()].map(([model_id, cost]) =>
    cost === undefined
      ? { model_id, excluded_reason: base.exclusionReasons.get(model_id) }
      : { model_id, cost_usd: roundHalfUp(cost, rounding.basket_cost_dp) },
  ) as Print["basket_costs"];

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
      variant,
    );
    return {
      policy_variant: variant.name,
      dated_siu: roundHalfUp(variantIndex.datedSiu, rounding.dated_siu_dp),
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
    dated_siu: roundHalfUp(base.datedSiu, rounding.dated_siu_dp),
    exchange_rate_table,
    sensitivity_block,
    rounding,
    price_snapshot_ref: input.price_snapshot_ref,
    methodology_version: input.methodology_version,
  };

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
