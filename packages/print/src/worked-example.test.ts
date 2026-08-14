import { describe, expect, it } from "vitest";
import { computePrint } from "./compute/index.js";
import { computeClassCost } from "./compute/class-cost.js";
import { cachePolicyVariant } from "./compute/sensitivity.js";
import { D } from "./decimal.js";
import { formatDeltaPercent, formatSpreadPercent } from "./rounding.js";
import { workedExampleInput } from "./worked-example.fixture.js";

/**
 * Reproduces docs/siu-worked-example.md end to end. This is the test the whole package exists
 * to pass: a silent arithmetic error anywhere in §6 poisons every downstream number, and
 * these are the figures that pin it down.
 */
describe("worked example reproduction", () => {
  const { body, computed } = computePrint(workedExampleInput());

  it("computes the stated per-task costs for every model", () => {
    const expected: Record<string, Record<string, string>> = {
      A: { T1: "0.0135", T2: "0.171", T3: "0.096" },
      B: { T1: "0.0057", T2: "0.1335", T3: "0.027" },
      // C's T3 is 0.0075 base x 1.6 mean attempts-to-first-pass = 0.012.
      C: { T1: "0.001542", T2: "0.03366", T3: "0.012" },
      D: { T1: "0.0004225", T2: "0.011495", T3: "n/a" },
    };

    for (const model of workedExampleInput().models) {
      for (const cls of ["T1", "T2", "T3"] as const) {
        const want = expected[model.model_id][cls];
        if (want === "n/a") continue;
        const records = model.records.filter((r) => r.task_class === cls);
        // Recompute the class cost directly so a failure points at the class, not the index.
        const result = computeClassCost(records, model.price);
        expect(result.cost?.toString(), `${model.model_id} ${cls}`).toBe(want);
      }
    }
  });

  it("computes the stated basket cost per model, with D undefined", () => {
    expect(computed.basketCosts.get("A")?.toString()).toBe("0.07725");
    expect(computed.basketCosts.get("B")?.toString()).toBe("0.0483");
    expect(computed.basketCosts.get("C")?.toString()).toBe("0.013269");
    expect(computed.basketCosts.get("D")).toBeUndefined();
  });

  it("excludes D from the reference set with a stated reason, not silently", () => {
    const reason = computed.exclusionReasons.get("D");
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/T3/);

    const row = body.basket_costs.find((r) => r.model_id === "D");
    expect(row).toBeTruthy();
    expect(row?.cost_usd).toBeUndefined();
    expect(row?.excluded_reason).toMatch(/T3/);
  });

  it("uses routed-market-share weights over the qualifying set, declared in the print", () => {
    expect(body.weights.source).toBe("routed-market-share");
    const byId = Object.fromEntries(body.weights.values.map((w) => [w.model_id, w.weight]));
    expect(byId).toEqual({ A: "0.200000", B: "0.350000", C: "0.450000" });
    expect(byId.D).toBeUndefined();
  });

  it("reproduces the Dated SIU of $0.0383", () => {
    expect(computed.datedSiu.toString()).toBe("0.03832605");
    expect(body.dated_siu).toBe("0.0383");
  });

  it("reproduces the exchange-rate table: $0.0773/+102%/12.9, $0.0483/+26%/20.7, $0.0133/-65%/75.3", () => {
    const byId = Object.fromEntries(body.exchange_rate_table.map((r) => [r.model_id, r]));

    expect(byId.A.usd_per_siu).toBe("0.0773");
    expect(formatSpreadPercent(byId.A.spread_to_index as string)).toBe("+102%");
    expect(byId.A.siu_per_usd).toBe("12.9");

    expect(byId.B.usd_per_siu).toBe("0.0483");
    expect(formatSpreadPercent(byId.B.spread_to_index as string)).toBe("+26%");
    expect(byId.B.siu_per_usd).toBe("20.7");

    expect(byId.C.usd_per_siu).toBe("0.0133");
    expect(formatSpreadPercent(byId.C.spread_to_index as string)).toBe("-65%");
    expect(byId.C.siu_per_usd).toBe("75.3");

    // D appears as a gap row rather than being dropped from the table.
    expect(byId.D.usd_per_siu).toBeUndefined();
    expect(byId.D.excluded_reason).toBeTruthy();
  });

  it("reproduces the cache-policy sensitivity delta of -12.3%", () => {
    const { body: withSensitivity } = computePrint({
      ...workedExampleInput(),
      sensitivityVariants: [
        cachePolicyVariant({
          cachedFraction: "0.40",
          cachedPriceRatio: "0.10",
          appliesTo: ["B"],
          taskClasses: ["T2"],
        }),
      ],
    });

    const variant = withSensitivity.sensitivity_block[0];
    expect(variant.dated_siu).toBe("0.0336");
    expect(formatDeltaPercent(variant.delta)).toBe("-12.3%");
    expect(variant.applies_to).toEqual(["B"]);
  });

  it("publishes basket costs precise enough to reproduce the headline Dated SIU", () => {
    // The reproducibility claim: a third party takes the published basket costs and published
    // weights, recomputes, and lands on the published Dated SIU. This fails at 4dp basket
    // costs (gives 0.0384), which is why the rounding rules publish them at 6dp.
    const weights = new Map(body.weights.values.map((w) => [w.model_id, w.weight]));
    let total = new D(0);
    for (const row of body.basket_costs) {
      if (!row.cost_usd) continue;
      total = total.plus(new D(row.cost_usd).times(weights.get(row.model_id) as string));
    }
    expect(total.toFixed(4, D.ROUND_HALF_UP)).toBe(body.dated_siu);
  });

  it("omits floor and market_spread when no measured floor is supplied", () => {
    expect(body.floor).toBeUndefined();
    expect(body.market_spread).toBeUndefined();
  });

  it("states its rounding rules in the print body", () => {
    expect(body.rounding.mode).toBe("ROUND_HALF_UP");
    expect(body.rounding.siu_per_usd_mode).toBe("ROUND_DOWN");
    expect(body.rounding.dated_siu_dp).toBe(4);
    expect(body.rounding.basket_cost_dp).toBe(6);
  });
});
