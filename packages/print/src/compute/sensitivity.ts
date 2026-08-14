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
}

export function applyAdjustment(price: ModelPrice, adjustment?: PolicyAdjustment): ModelPrice {
  if (!adjustment) {
    return price;
  }
  return {
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
