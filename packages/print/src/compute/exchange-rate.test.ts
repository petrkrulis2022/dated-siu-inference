import { describe, expect, it } from "vitest";
import { D, type DecimalValue } from "../decimal.js";
import { computeExchangeRateTable } from "./exchange-rate.js";

const DATED_SIU = new D("0.0383");

describe("computeExchangeRateTable", () => {
  it("computes usd_per_siu, spread to index, and SIU per $1", () => {
    const costs = new Map<string, DecimalValue | undefined>([["A", new D("0.0766")]]);
    const [row] = computeExchangeRateTable(costs, new Map(), DATED_SIU);
    expect(row.usd_per_siu?.toString()).toBe("0.0766");
    expect(row.spread_to_index?.toString()).toBe("1"); // exactly 2x the index -> +100%
    expect(row.siu_per_usd?.toFixed(4)).toBe("13.0548");
  });

  it("gives a negative spread for a model cheaper than the index", () => {
    const costs = new Map<string, DecimalValue | undefined>([["C", new D("0.01915")]]);
    const [row] = computeExchangeRateTable(costs, new Map(), DATED_SIU);
    expect(row.spread_to_index?.toString()).toBe("-0.5"); // half the index -> -50%
  });

  it("gives a zero spread for a model priced exactly at the index", () => {
    const costs = new Map<string, DecimalValue | undefined>([["X", new D("0.0383")]]);
    const [row] = computeExchangeRateTable(costs, new Map(), DATED_SIU);
    expect(row.spread_to_index?.toString()).toBe("0");
  });

  it("emits a gap row carrying the exclusion reason, not a dropped row", () => {
    // §6.2: an excluded model "appears in the table with a gap". A reader must be able to see
    // that the model was measured and failed, not that it was never measured.
    const costs = new Map<string, DecimalValue | undefined>([["D", undefined]]);
    const reasons = new Map([["D", "undefined class: T3 (all 5 instance(s) failed)"]]);
    const [row] = computeExchangeRateTable(costs, reasons, DATED_SIU);
    expect(row.model_id).toBe("D");
    expect(row.usd_per_siu).toBeUndefined();
    expect(row.excluded_reason).toMatch(/T3/);
  });

  it("excludes a zero-cost basket rather than emitting an infinite SIU-per-dollar", () => {
    const costs = new Map<string, DecimalValue | undefined>([["free", new D("0")]]);
    const [row] = computeExchangeRateTable(costs, new Map(), DATED_SIU);
    expect(row.siu_per_usd).toBeUndefined();
    expect(row.excluded_reason).toMatch(/zero/);
  });

  it("preserves every model in the table, excluded or not", () => {
    const costs = new Map<string, DecimalValue | undefined>([
      ["A", new D("0.0766")],
      ["D", undefined],
    ]);
    const rows = computeExchangeRateTable(costs, new Map(), DATED_SIU);
    expect(rows.map((r) => r.model_id)).toEqual(["A", "D"]);
  });
});
