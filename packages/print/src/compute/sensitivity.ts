import type { RunRecord } from "@touchstone/sdk";
import { D } from "../decimal.js";
import type { TaskClass } from "./basket-cost.js";
import type { ModelPrice } from "./class-cost.js";

/**
 * A policy variant expressed as per-(model, class) multipliers on the input and output
 * price — build1-spec.md §6.7: "Recompute the print under alternative cache and batch-discount
 * policies and publish the delta."
 *
 * Every policy this block needs to express is a scaling of what a token costs, so encoding
 * variants as price multipliers lets the sensitivity recompute run through the exact same
 * cost/basket/index code as the headline number. A variant that had its own parallel
 * arithmetic could drift from the headline and nobody would notice.
 */
export interface PolicyAdjustment {
  inputMultiplier: string;
  outputMultiplier: string;
}

export interface PolicyVariant {
  name: string;
  /** Model ids the variant applies to; published alongside the delta. */
  appliesTo: string[];
  adjust: (modelId: string, taskClass: TaskClass) => PolicyAdjustment | undefined;
  /**
   * Optional: the usage a run record is priced on under this variant, where the policy changes WHAT is billed and not what a token costs (the successful-call basis below). Absent means every
   * record keeps its own usage. It runs through the same cost, basket and index code as the headline, like the price adjustments do.
   */
  adjustUsage?: (modelId: string, record: RunRecord) => RunRecord["usage"];
}

export function applyAdjustment(price: ModelPrice, adjustment?: PolicyAdjustment): ModelPrice {
  if (!adjustment) {
    return price;
  }
  return {
    ...price,
    price_in_usd_per_1m: new D(price.price_in_usd_per_1m)
      .times(adjustment.inputMultiplier)
      .toString(),
    price_out_usd_per_1m: new D(price.price_out_usd_per_1m)
      .times(adjustment.outputMultiplier)
      .toString(),
  };
}

export interface CachePolicyOptions {
  /** Fraction of input tokens served from cache, e.g. "0.40". */
  cachedFraction: string;
  /** Cache price as a fraction of full input price, e.g. "0.10" for 10%. */
  cachedPriceRatio: string;
  /**
   * Which models the variant applies to. Required and explicit: prompt caching is not offered
   * uniformly across providers, and silently applying it to every model would publish a
   * sensitivity figure that no real policy change could produce.
   */
  appliesTo: string[];
  /** Which classes carry cacheable context. Defaults to T2, the long-context class. */
  taskClasses?: TaskClass[];
  name?: string;
}

/**
 * Cache-policy variant. A fraction `f` of input tokens billed at `r` × the input price is
 * exactly a multiplier of `(1 − f) + f·r` on the input price, so it reduces to an adjustment
 * with no separate code path.
 */
export function cachePolicyVariant(options: CachePolicyOptions): PolicyVariant {
  const classes = new Set<TaskClass>(options.taskClasses ?? ["T2"]);
  const models = new Set(options.appliesTo);
  const f = new D(options.cachedFraction);
  const inputMultiplier = new D(1).minus(f).plus(f.times(options.cachedPriceRatio)).toString();

  return {
    name:
      options.name ??
      `cache-enabled: ${new D(options.cachedFraction).times(100).toString()}% of ${[...classes].join("/")} input at ${new D(options.cachedPriceRatio).times(100).toString()}% of input price`,
    appliesTo: [...models],
    adjust: (modelId, taskClass) =>
      models.has(modelId) && classes.has(taskClass)
        ? { inputMultiplier, outputMultiplier: "1" }
        : undefined,
  };
}

export interface BatchDiscountOptions {
  /** Discount off both input and output prices, e.g. "0.50" for 50% off. */
  discount: string;
  appliesTo: string[];
  taskClasses?: TaskClass[];
  name?: string;
}

/** Batch-discount variant: a flat discount on both input and output prices. */
export function batchDiscountVariant(options: BatchDiscountOptions): PolicyVariant {
  const models = new Set(options.appliesTo);
  const classes = options.taskClasses ? new Set<TaskClass>(options.taskClasses) : undefined;
  const multiplier = new D(1).minus(options.discount).toString();

  return {
    name:
      options.name ??
      `batch-discount: ${new D(options.discount).times(100).toString()}% off input and output`,
    appliesTo: [...models],
    adjust: (modelId, taskClass) =>
      models.has(modelId) && (!classes || classes.has(taskClass))
        ? { inputMultiplier: multiplier, outputMultiplier: multiplier }
        : undefined,
  };
}

/** The exact name the successful-call variant carries in a print's sensitivity block. Verification finds the variant by this name, so it never applies to a print that did not publish it. */
export const SUCCESSFUL_CALL_VARIANT_NAME =
  "successful-call-only: a retried run's discarded first call not priced (docs/methodology.md, rules-2026-10-24)";

/**
 * The usage of the discarded first call of a retried run, by run id. A run whose completion was cut off by its budget is retried with a larger one (`REASONING_BUDGET_MULTIPLE`); the provider
 * bills both calls, and the record's usage is their sum. This is the cut-off call alone, taken from the saved raw response.
 */
export type DiscardedFirstCalls = ReadonlyMap<string, RunRecord["usage"]>;

export interface SuccessfulCallOptions {
  discarded: DiscardedFirstCalls;
  /** The models that have at least one discarded call among these inputs; published with the delta. */
  appliesTo: string[];
  name?: string;
}

/**
 * The successful-call basis (docs/methodology.md, rules-2026-10-24): what the print would be if each retried run were priced on its successful call alone, as a buyer who had set the right budget
 * from the start would pay. Published beside the headline during the notice period, never in place of it. It changes no price: it takes the discarded call's tokens off the usage of the runs that
 * have one, and everything else is the headline's own arithmetic.
 */
export function successfulCallVariant(options: SuccessfulCallOptions): PolicyVariant {
  const models = new Set(options.appliesTo);
  return {
    name: options.name ?? SUCCESSFUL_CALL_VARIANT_NAME,
    appliesTo: [...models],
    adjust: () => undefined,
    adjustUsage: (modelId, record) => {
      const gone = models.has(modelId) ? options.discarded.get(record.run_id) : undefined;
      if (gone === undefined) return record.usage;
      const take = (have: number, off: number): number => Math.max(0, have - off);
      return {
        input: take(record.usage.input, gone.input),
        output: take(record.usage.output, gone.output),
        cached_input: take(record.usage.cached_input, gone.cached_input),
        reasoning: take(record.usage.reasoning, gone.reasoning),
      };
    },
  };
}
