import { D, type DecimalValue } from "../decimal.js";
import type { ClassCost } from "./class-cost.js";

export type TaskClass = "T1" | "T2" | "T3";

export type ClassWeights = Record<TaskClass, string>;

export interface BasketCost {
  /** Undefined if ANY class is undefined — build1-spec.md §6.2. */
  cost?: DecimalValue;
  undefinedReason?: string;
  classCosts: Partial<Record<TaskClass, DecimalValue>>;
}

/**
 * Basket cost for one model: Σ_classes weight × cost_class — build1-spec.md §6.2.
 * Undefined if any class is undefined; that model is then excluded from the reference set
 * and appears in the published table with a gap.
 */
export function computeBasketCost(
  classCosts: Record<TaskClass, ClassCost>,
  weights: ClassWeights,
): BasketCost {
  const classes: TaskClass[] = ["T1", "T2", "T3"];
  const resolved: Partial<Record<TaskClass, DecimalValue>> = {};
  const missing: string[] = [];

  for (const cls of classes) {
    const classCost = classCosts[cls];
    if (!classCost || classCost.cost === undefined) {
      missing.push(`${cls} (${classCost?.undefinedReason ?? "no data"})`);
      continue;
    }
    resolved[cls] = classCost.cost;
  }

  if (missing.length > 0) {
    return { undefinedReason: `undefined class: ${missing.join("; ")}`, classCosts: resolved };
  }

  let total = new D(0);
  for (const cls of classes) {
    total = total.plus(new D(weights[cls]).times(resolved[cls] as DecimalValue));
  }

  return { cost: total, classCosts: resolved };
}
