import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { computeBasketCost, type ClassWeights } from "./basket-cost.js";
import type { ClassCost } from "./class-cost.js";

const WEIGHTS: ClassWeights = { T1: "0.50", T2: "0.30", T3: "0.20" };

function defined(value: string): ClassCost {
  return { cost: new D(value), passingInstances: 5, totalInstances: 5 };
}

function undefinedClass(reason: string): ClassCost {
  return { passingInstances: 0, totalInstances: 5, undefinedReason: reason };
}

describe("computeBasketCost", () => {
  it("computes the weighted sum across the three classes", () => {
    const result = computeBasketCost(
      { T1: defined("0.0135"), T2: defined("0.171"), T3: defined("0.096") },
      WEIGHTS,
    );
    // 0.5(0.0135) + 0.3(0.171) + 0.2(0.096) = 0.00675 + 0.0513 + 0.0192
    expect(result.cost?.toString()).toBe("0.07725");
  });

  it("is undefined if ANY class is undefined, naming which", () => {
    const result = computeBasketCost(
      { T1: defined("0.01"), T2: defined("0.02"), T3: undefinedClass("all 5 instance(s) failed") },
      WEIGHTS,
    );
    expect(result.cost).toBeUndefined();
    expect(result.undefinedReason).toMatch(/T3/);
    expect(result.undefinedReason).toMatch(/failed/);
  });

  it("is undefined when more than one class is undefined, naming all of them", () => {
    const result = computeBasketCost(
      { T1: undefinedClass("no records"), T2: defined("0.02"), T3: undefinedClass("all failed") },
      WEIGHTS,
    );
    expect(result.cost).toBeUndefined();
    expect(result.undefinedReason).toMatch(/T1/);
    expect(result.undefinedReason).toMatch(/T3/);
  });

  it("still reports the classes that were defined, for diagnostics", () => {
    const result = computeBasketCost(
      { T1: defined("0.01"), T2: defined("0.02"), T3: undefinedClass("all failed") },
      WEIGHTS,
    );
    expect(result.classCosts.T1?.toString()).toBe("0.01");
    expect(result.classCosts.T2?.toString()).toBe("0.02");
    expect(result.classCosts.T3).toBeUndefined();
  });

  it("respects the declared class weights rather than averaging equally", () => {
    const equalCosts = { T1: defined("1"), T2: defined("0"), T3: defined("0") };
    // With T1 weighted 0.50, a basket of (1, 0, 0) must be 0.5 — an equal average would be 0.333.
    expect(computeBasketCost(equalCosts, WEIGHTS).cost?.toString()).toBe("0.5");
  });
});
