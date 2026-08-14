import { describe, expect, it } from "vitest";
import { decimalLessThanOrEqual, relativeDelta, sumCosts, tokenCost } from "./decimal.js";

describe("tokenCost", () => {
  it("computes tokens * pricePerMillion / 1e6 exactly", () => {
    expect(tokenCost(1_000_000, "3.00")).toBe("3");
    expect(tokenCost(500_000, "3.00")).toBe("1.5");
    expect(tokenCost(0, "3.00")).toBe("0");
  });
});

describe("sumCosts", () => {
  it("sums decimal strings exactly, avoiding float drift", () => {
    expect(sumCosts(["0.1", "0.2"])).toBe("0.3");
    expect(sumCosts([])).toBe("0");
  });
});

describe("relativeDelta", () => {
  it("computes the relative difference between two decimal strings", () => {
    expect(relativeDelta("110", "100")).toBe("0.1");
    expect(relativeDelta("100", "100")).toBe("0");
  });

  it("handles a zero baseline without dividing by zero", () => {
    expect(relativeDelta("0", "0")).toBe("0");
    expect(relativeDelta("5", "0")).toBe("1");
  });
});

describe("decimalLessThanOrEqual", () => {
  it("compares by value, not lexicographically, including equality", () => {
    expect(decimalLessThanOrEqual("9.5", "10.2")).toBe(true);
    expect(decimalLessThanOrEqual("10.2", "9.5")).toBe(false);
    expect(decimalLessThanOrEqual("5", "5")).toBe(true);
  });
});
