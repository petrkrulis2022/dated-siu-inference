import { describe, expect, it } from "vitest";
import { computePrint, type CarryForwardDay } from "./index.js";
import { D } from "../decimal.js";
import { workedExampleInput } from "../worked-example.fixture.js";

/**
 * D's T3 class fails outright in the worked-example fixture (allFailRecords), so D has no
 * basket cost and is excluded — worked-example.test.ts already pins that baseline behaviour.
 * These tests reuse the same fixture to exercise the carry-forward-cap fix (docs/methodology.md's
 * Aggregation section, adopted 2026-09-26) without duplicating that baseline.
 */
describe("computePrint — carry-forward cap (2026-09-26 methodology fix)", () => {
  const baseInput = workedExampleInput(); // date: 2026-08-14

  it("carries a missing model's last real cost forward when within the 3-day cap", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-12", costs: new Map([["D", new D("0.05")]]) }, // 2 days back
    ];
    const { body, computed } = computePrint({ ...baseInput, carryForwardHistory: history });

    expect(computed.basketCosts.get("D")?.toString()).toBe("0.05");
    expect(computed.carriedForward.get("D")).toEqual({ fromDate: "2026-08-12", cost: new D("0.05") });
    expect(computed.exclusionReasons.has("D")).toBe(false);

    const row = body.basket_costs.find((r) => r.model_id === "D");
    expect(row?.cost_usd).toBe("0.050000");
    expect(row?.carried_forward_from).toBe("2026-08-12");
    expect(row?.excluded_reason).toBeUndefined();

    // D now qualifies, so it must be weighted and included in the blend — never a silent
    // number that doesn't actually move dated_siu.
    expect(body.weights.values.some((w) => w.model_id === "D")).toBe(true);
  });

  it("does not carry forward beyond the 3-day cap — the model stays excluded", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-10", costs: new Map([["D", new D("0.05")]]) }, // 4 days back
    ];
    const { body, computed } = computePrint({ ...baseInput, carryForwardHistory: history });

    expect(computed.basketCosts.get("D")).toBeUndefined();
    expect(computed.carriedForward.has("D")).toBe(false);
    const row = body.basket_costs.find((r) => r.model_id === "D");
    expect(row?.cost_usd).toBeUndefined();
    expect(row?.carried_forward_from).toBeUndefined();
    expect(row?.excluded_reason).toBeTruthy();
  });

  it("never carries forward a model that already has a real cost today", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-13", costs: new Map([["A", new D("999")]]) },
    ];
    const { body, computed } = computePrint({ ...baseInput, carryForwardHistory: history });

    expect(computed.carriedForward.has("A")).toBe(false);
    const row = body.basket_costs.find((r) => r.model_id === "A");
    expect(row?.cost_usd).toBe("0.077250"); // the real, freshly measured cost — not 999
    expect(row?.carried_forward_from).toBeUndefined();
  });

  it("picks the nearest qualifying prior day within the window, not just the first entry", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-13", costs: new Map() }, // 1 day back, but D didn't qualify that day either
      { date: "2026-08-12", costs: new Map([["D", new D("0.02")]]) }, // 2 days back, real value
    ];
    const { computed } = computePrint({ ...baseInput, carryForwardHistory: history });
    expect(computed.carriedForward.get("D")?.fromDate).toBe("2026-08-12");
    expect(computed.basketCosts.get("D")?.toString()).toBe("0.02");
  });

  it("ignores carryForwardHistory entirely when absent — pre-existing behaviour is unchanged", () => {
    const { body, computed } = computePrint(baseInput);
    expect(computed.basketCosts.get("D")).toBeUndefined();
    expect(body.basket_costs.find((r) => r.model_id === "D")?.excluded_reason).toBeTruthy();
  });
});

describe("computePrint — dated_siu_median_diagnostic (2026-09-26 methodology fix)", () => {
  it("publishes the unweighted median of the qualifying set as a diagnostic only", () => {
    const { body, computed } = computePrint(workedExampleInput());
    // Qualifying set is A/B/C only (D excluded) — costs 0.07725 / 0.0483 / 0.013269.
    // Median of 3 values is the middle one once sorted: 0.0483.
    expect(computed.medianDiagnostic.toString()).toBe("0.0483");
    expect(body.dated_siu_median_diagnostic).toBe("0.04830");
    // Never the same as the primary statistic — that's the whole point of this being a
    // diagnostic (mean is weighted 0.20/0.35/0.45, not equal, in this fixture).
    expect(body.dated_siu_median_diagnostic).not.toBe(body.dated_siu);
  });

  it("is genuinely unweighted — an even-count qualifying set averages the two middle costs", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-12", costs: new Map([["D", new D("0.013269")]]) }, // ties with C
    ];
    const { computed } = computePrint({
      ...workedExampleInput(),
      carryForwardHistory: history,
    });
    // Qualifying set now A/B/C/D: 0.07725, 0.0483, 0.013269, 0.013269 (carried, ties C).
    // Sorted: 0.013269, 0.013269, 0.0483, 0.07725 — median = (0.013269 + 0.0483) / 2.
    expect(computed.medianDiagnostic.toString()).toBe("0.0307845");
  });
});
