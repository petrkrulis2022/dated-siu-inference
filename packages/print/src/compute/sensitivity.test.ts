import { describe, expect, it } from "vitest";
import { applyAdjustment, batchDiscountVariant, cachePolicyVariant } from "./sensitivity.js";

const PRICE = { price_in_usd_per_1m: "2.50", price_out_usd_per_1m: "10.00" };

describe("cachePolicyVariant", () => {
  it("converts a cache fraction and ratio into an input-price multiplier", () => {
    // 40% of input at 10% of price -> multiplier = 0.6 + 0.4(0.1) = 0.64.
    const variant = cachePolicyVariant({
      cachedFraction: "0.40",
      cachedPriceRatio: "0.10",
      appliesTo: ["B"],
    });
    const adjusted = applyAdjustment(PRICE, variant.adjust("B", "T2"));
    expect(adjusted.price_in_usd_per_1m).toBe("1.6"); // 2.50 x 0.64
    expect(adjusted.price_out_usd_per_1m).toBe("10"); // output unaffected by caching
  });

  it("applies only to the named models", () => {
    const variant = cachePolicyVariant({
      cachedFraction: "0.40",
      cachedPriceRatio: "0.10",
      appliesTo: ["B"],
    });
    expect(variant.adjust("B", "T2")).toBeDefined();
    // A is not in appliesTo — caching is not offered uniformly across providers, so applying
    // it to every model would publish a sensitivity no real policy change could produce.
    expect(variant.adjust("A", "T2")).toBeUndefined();
  });

  it("applies only to the named task classes, defaulting to T2", () => {
    const variant = cachePolicyVariant({
      cachedFraction: "0.40",
      cachedPriceRatio: "0.10",
      appliesTo: ["B"],
    });
    expect(variant.adjust("B", "T2")).toBeDefined();
    expect(variant.adjust("B", "T1")).toBeUndefined();
    expect(variant.adjust("B", "T3")).toBeUndefined();
  });

  it("publishes which models it applied to", () => {
    const variant = cachePolicyVariant({
      cachedFraction: "0.40",
      cachedPriceRatio: "0.10",
      appliesTo: ["B", "C"],
    });
    expect(variant.appliesTo).toEqual(["B", "C"]);
    expect(variant.name).toMatch(/cache/i);
  });

  it("a 100% cache fraction at 0% price makes input free", () => {
    const variant = cachePolicyVariant({
      cachedFraction: "1",
      cachedPriceRatio: "0",
      appliesTo: ["B"],
    });
    expect(applyAdjustment(PRICE, variant.adjust("B", "T2")).price_in_usd_per_1m).toBe("0");
  });
});

describe("batchDiscountVariant", () => {
  it("discounts both input and output prices", () => {
    const variant = batchDiscountVariant({ discount: "0.50", appliesTo: ["B"] });
    const adjusted = applyAdjustment(PRICE, variant.adjust("B", "T1"));
    expect(adjusted.price_in_usd_per_1m).toBe("1.25");
    expect(adjusted.price_out_usd_per_1m).toBe("5");
  });

  it("applies across all classes by default", () => {
    const variant = batchDiscountVariant({ discount: "0.50", appliesTo: ["B"] });
    for (const cls of ["T1", "T2", "T3"] as const) {
      expect(variant.adjust("B", cls)).toBeDefined();
    }
  });

  it("applies only to the named models", () => {
    const variant = batchDiscountVariant({ discount: "0.50", appliesTo: ["B"] });
    expect(variant.adjust("A", "T1")).toBeUndefined();
  });
});

describe("applyAdjustment", () => {
  it("returns the price unchanged when there is no adjustment", () => {
    expect(applyAdjustment(PRICE, undefined)).toEqual(PRICE);
  });

  it("never mutates the price it was given", () => {
    const original = { ...PRICE };
    applyAdjustment(PRICE, { inputMultiplier: "0.5", outputMultiplier: "0.5" });
    expect(PRICE).toEqual(original);
  });
});
