import { describe, expect, it } from "vitest";
import type { RunRecord } from "@touchstone/sdk";
import { computePrint, type CarryForwardDay } from "./index.js";
import { computeClassCost, type ModelPrice } from "./class-cost.js";
import { computeBasketCost } from "./basket-cost.js";
import { workedExampleInput } from "../worked-example.fixture.js";

// D's own real price in the worked-example fixture (worked-example.fixture.ts's PRICES.D) —
// duplicated here (not exported) so these tests can compute an expected reprice independently.
const D_PRICE: ModelPrice = { price_in_usd_per_1m: "0.20", price_out_usd_per_1m: "0.45" };
const CLASS_WEIGHTS = { T1: "0.50", T2: "0.30", T3: "0.20" };

function carriedRecord(taskClass: "T1" | "T2" | "T3", input: number, output: number): RunRecord {
  return {
    run_id: `carried-D-${taskClass}`,
    model_id: "D",
    task_class: taskClass,
    instance_id: `${taskClass}-carried`,
    seed: 1,
    attempt: 1,
    usage: { input, output, cached_input: 0, reasoning: 0 },
    latency_ms: 100,
    gate_passed: true,
    raw_response_ref: `carried-D-${taskClass}.raw.json`,
    deviations: [],
  };
}

/** A full prior day's worth of real, measured usage for D — one passing instance per class, so
 * repricing it (at whatever price is handed in) produces a real, defined basket cost, exactly
 * like a genuinely measured model would. */
function dPriorDayRecords(): RunRecord[] {
  return [carriedRecord("T1", 1000, 500), carriedRecord("T2", 2000, 800), carriedRecord("T3", 1500, 600)];
}

/** Reprices dPriorDayRecords() at `price` via the real per-class pipeline — the same
 * ground truth computeIndex's own carry-forward step uses — so these tests never hand-compute
 * an expected number that could quietly drift from what the production code actually does. */
function expectedRepriceOf(records: RunRecord[], price: ModelPrice): string {
  const byClass = {
    T1: computeClassCost(records.filter((r) => r.task_class === "T1"), price),
    T2: computeClassCost(records.filter((r) => r.task_class === "T2"), price),
    T3: computeClassCost(records.filter((r) => r.task_class === "T3"), price),
  };
  const basket = computeBasketCost(byClass, CLASS_WEIGHTS);
  if (basket.cost === undefined) throw new Error("test fixture itself doesn't reprice to a defined cost");
  return basket.cost.toString();
}

/**
 * D's T3 class fails outright in the worked-example fixture (allFailRecords), so D has no
 * basket cost and is excluded — worked-example.test.ts already pins that baseline behaviour.
 * These tests reuse the same fixture to exercise the carry-forward-cap fix (docs/methodology.md's
 * Aggregation section, adopted 2026-09-26, redesigned 2026-09-27 to carry forward measured usage
 * and reprice it at today's snapshot rather than reusing the source day's own already-computed
 * cost — so a provider price change during an outage still shows up in the imputed row).
 */
describe("computePrint — carry-forward cap (usage-based, 2026-09-27)", () => {
  const baseInput = workedExampleInput(); // date: 2026-08-14

  it("carries a missing model's last real usage forward and reprices it at today's price, when within the 3-day cap", () => {
    const records = dPriorDayRecords();
    const history: CarryForwardDay[] = [
      { date: "2026-08-12", records: new Map([["D", records]]) }, // 2 days back
    ];
    const { body, computed } = computePrint({ ...baseInput, carryForwardHistory: history });
    const expectedCost = expectedRepriceOf(records, D_PRICE);

    expect(computed.basketCosts.get("D")?.toString()).toBe(expectedCost);
    expect(computed.carriedForward.get("D")?.fromDate).toBe("2026-08-12");
    expect(computed.carriedForward.get("D")?.cost.toString()).toBe(expectedCost);
    expect(computed.exclusionReasons.has("D")).toBe(false);

    const row = body.basket_costs.find((r) => r.model_id === "D");
    expect(row?.cost_usd).toBeDefined();
    expect(row?.carried_forward_from).toBe("2026-08-12");
    expect(row?.excluded_reason).toBeUndefined();

    // D now qualifies, so it must be weighted and included in the blend — never a silent
    // number that doesn't actually move dated_siu.
    expect(body.weights.values.some((w) => w.model_id === "D")).toBe(true);
  });

  it("reprices at TODAY's price, not the source day's — a provider price change shows up even while the model's own runs are down", () => {
    const records = dPriorDayRecords();
    // Today's price for D is much higher than when these records were actually measured.
    const todaysPrice: ModelPrice = { price_in_usd_per_1m: "2.00", price_out_usd_per_1m: "4.50" };
    const history: CarryForwardDay[] = [{ date: "2026-08-12", records: new Map([["D", records]]) }];
    const inflatedInput = {
      ...baseInput,
      models: baseInput.models.map((m) => (m.model_id === "D" ? { ...m, price: todaysPrice } : m)),
      carryForwardHistory: history,
    };

    const { computed } = computePrint(inflatedInput);
    const expectedAtOldPrice = expectedRepriceOf(records, D_PRICE);
    const expectedAtTodaysPrice = expectedRepriceOf(records, todaysPrice);

    expect(expectedAtTodaysPrice).not.toBe(expectedAtOldPrice); // sanity: the fixture prices actually differ
    expect(computed.basketCosts.get("D")?.toString()).toBe(expectedAtTodaysPrice);
  });

  it("does not carry forward beyond the 3-day cap — the model stays excluded", () => {
    const history: CarryForwardDay[] = [
      { date: "2026-08-10", records: new Map([["D", dPriorDayRecords()]]) }, // 4 days back
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
      { date: "2026-08-13", records: new Map([["A", dPriorDayRecords()]]) },
    ];
    const { body, computed } = computePrint({ ...baseInput, carryForwardHistory: history });

    expect(computed.carriedForward.has("A")).toBe(false);
    const row = body.basket_costs.find((r) => r.model_id === "A");
    expect(row?.cost_usd).toBe("0.077250"); // the real, freshly measured cost — not the carried fixture
    expect(row?.carried_forward_from).toBeUndefined();
  });

  it("picks the nearest qualifying prior day within the window, not just the first entry", () => {
    const nearRecords = dPriorDayRecords();
    const history: CarryForwardDay[] = [
      { date: "2026-08-13", records: new Map() }, // 1 day back, but D didn't qualify that day either
      { date: "2026-08-12", records: new Map([["D", nearRecords]]) }, // 2 days back, real usage
    ];
    const { computed } = computePrint({ ...baseInput, carryForwardHistory: history });
    expect(computed.carriedForward.get("D")?.fromDate).toBe("2026-08-12");
    expect(computed.basketCosts.get("D")?.toString()).toBe(expectedRepriceOf(nearRecords, D_PRICE));
  });

  it("ignores carryForwardHistory entirely when absent — pre-existing behaviour is unchanged", () => {
    const { body, computed } = computePrint(baseInput);
    expect(computed.basketCosts.get("D")).toBeUndefined();
    expect(body.basket_costs.find((r) => r.model_id === "D")?.excluded_reason).toBeTruthy();
  });
});

describe("computePrint — dated_siu_median_diagnostic (2026-09-26 methodology fix)", () => {
  it("is always computed into ComputedIndex, but never published on the body unless explicitly opted in", () => {
    // Found live, 2026-09-26: this feature (median + carry-forward together) shipped ahead of
    // its own retro-validation being reviewed — publishMedianDiagnostic defaults to omitted
    // (not true) for exactly the same reason cli/publish.ts and cli/publish-unattended.ts now
    // gate both behind one explicit, defaults-OFF flag (TOUCHSTONE_CARRY_FORWARD_ENABLED).
    const { body, computed } = computePrint(workedExampleInput());
    expect(computed.medianDiagnostic.toString()).toBe("0.0483");
    expect(body.dated_siu_median_diagnostic).toBeUndefined();
  });

  it("publishes the unweighted median of the qualifying set as a diagnostic only, once opted in", () => {
    const { body, computed } = computePrint({ ...workedExampleInput(), publishMedianDiagnostic: true });
    // Qualifying set is A/B/C only (D excluded) — costs 0.07725 / 0.0483 / 0.013269.
    // Median of 3 values is the middle one once sorted: 0.0483.
    expect(computed.medianDiagnostic.toString()).toBe("0.0483");
    expect(body.dated_siu_median_diagnostic).toBe("0.04830");
    // Never the same as the primary statistic — that's the whole point of this being a
    // diagnostic (mean is weighted 0.20/0.35/0.45, not equal, in this fixture).
    expect(body.dated_siu_median_diagnostic).not.toBe(body.dated_siu);
  });

  it("is genuinely unweighted — an even-count qualifying set averages the two middle costs", () => {
    const records = dPriorDayRecords();
    const history: CarryForwardDay[] = [{ date: "2026-08-12", records: new Map([["D", records]]) }];
    const { computed } = computePrint({
      ...workedExampleInput(),
      carryForwardHistory: history,
    });
    // Qualifying set now A/B/C/D: A=0.07725, B=0.0483, C=0.013269, D=carried (repriced at D's
    // own real price — see expectedRepriceOf). Median of 4 sorted values is the average of the
    // two middle ones — computed independently here, not hand-derived, since which two values
    // land in the middle depends on where D's own repriced cost happens to fall.
    const dCost = Number(expectedRepriceOf(records, D_PRICE));
    const sorted = [0.07725, 0.0483, 0.013269, dCost].sort((a, b) => a - b);
    const expectedMedian = (sorted[1] + sorted[2]) / 2;
    expect(Number(computed.medianDiagnostic.toString())).toBeCloseTo(expectedMedian, 9);
  });
});
