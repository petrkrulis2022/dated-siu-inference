import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { computeDatedSiu, resolveWeights } from "./weights.js";

describe("resolveWeights", () => {
  it("uses routed-market share when it covers the qualifying set", () => {
    const { source, weights } = resolveWeights(
      ["A", "B"],
      new Map([
        ["A", "0.20"],
        ["B", "0.60"],
      ]),
    );
    expect(source).toBe("routed-market-share");
    // 0.20 and 0.60 normalise to 0.25 and 0.75 — they must sum to 1, not stay at 0.8.
    expect(weights.get("A")?.toString()).toBe("0.25");
    expect(weights.get("B")?.toString()).toBe("0.75");
  });

  it("normalises over the qualifying set only, redistributing a disqualified model's share", () => {
    // D is disqualified. Its 10% must be spread across A/B/C, not silently dropped — dropping
    // it would leave the weights summing to 0.9 and deflate the index by 10%.
    const shares = new Map([
      ["A", "0.20"],
      ["B", "0.35"],
      ["C", "0.35"],
      ["D", "0.10"],
    ]);
    const { weights } = resolveWeights(["A", "B", "C"], shares);
    const total = [...weights.values()].reduce((acc, w) => acc.plus(w), new D(0));
    expect(total.toString()).toBe("1");
    expect(weights.has("D")).toBe(false);
    expect(weights.get("A")?.toFixed(6)).toBe("0.222222");
  });

  it("produces weights summing to 1 far inside publication precision", () => {
    // A three-way split makes each weight 1/3, which has no exact decimal representation, so
    // the sum is 1 − 1e-40 rather than exactly 1. That residual is ~36 orders of magnitude
    // below the 4dp the index publishes at, so it cannot move a published figure. Forcing an
    // exact 1 by dumping the residual onto one arbitrary model would misstate that model's
    // real share to buy a cosmetic property, so the residual is left where it falls.
    const { weights } = resolveWeights(
      ["A", "B", "C"],
      new Map([
        ["A", "1"],
        ["B", "1"],
        ["C", "1"],
      ]),
    );
    const total = [...weights.values()].reduce((acc, w) => acc.plus(w), new D(0));
    expect(total.minus(1).abs().lessThan("1e-30")).toBe(true);
    expect(total.toFixed(10)).toBe("1.0000000000");
  });

  it("falls back to equal weights when no share data is supplied, and declares it", () => {
    const { source, weights } = resolveWeights(["A", "B", "C", "D"]);
    expect(source).toBe("equal");
    expect(weights.get("A")?.toString()).toBe("0.25");
  });

  it("falls back to equal weights when share data does not cover every qualifying model", () => {
    // Partial coverage would mean inventing a share for the uncovered model. Fall back
    // wholesale and say so, rather than half-using data that does not apply.
    const { source } = resolveWeights(["A", "B"], new Map([["A", "0.20"]]));
    expect(source).toBe("equal");
  });

  it("falls back to equal weights when the covering shares sum to zero", () => {
    const { source } = resolveWeights(
      ["A", "B"],
      new Map([
        ["A", "0"],
        ["B", "0"],
      ]),
    );
    expect(source).toBe("equal");
  });

  it("throws when the qualifying set is empty rather than emitting a meaningless index", () => {
    expect(() => resolveWeights([])).toThrow(/qualifying set is empty/);
  });
});

describe("computeDatedSiu", () => {
  it("computes the share-weighted mean of basket costs", () => {
    const costs = new Map([
      ["A", new D("0.10")],
      ["B", new D("0.20")],
    ]);
    const weights = new Map([
      ["A", new D("0.25")],
      ["B", new D("0.75")],
    ]);
    expect(computeDatedSiu(costs, weights).toString()).toBe("0.175");
  });

  it("throws if a weight refers to a model with no basket cost", () => {
    const costs = new Map([["A", new D("0.10")]]);
    const weights = new Map([
      ["A", new D("0.5")],
      ["ghost", new D("0.5")],
    ]);
    expect(() => computeDatedSiu(costs, weights)).toThrow(/ghost/);
  });
});
