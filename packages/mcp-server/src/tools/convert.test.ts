import { describe, expect, it } from "vitest";
import type { Print, PriceSnapshot } from "@touchstone/sdk";
import { convertTool } from "./convert.js";

function fixturePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-14",
    date: "2026-08-14",
    status: "provisional",
    basket_costs: [{ model_id: "A", cost_usd: "0.001" }],
    weights: { source: "equal", values: [{ model_id: "A", weight: "1" }] },
    dated_siu: "0.0019",
    exchange_rate_table: [
      { model_id: "A", usd_per_siu: "0.10", spread_to_index: "0", siu_per_usd: "10" },
    ],
    sensitivity_block: [{ policy_variant: "none", dated_siu: "0.0019", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "0.06",
    price_snapshot_ref: "snap-1.json",
    methodology_version: "v0-draft",
    signature: `0x${"ab".repeat(64)}`,
    public_key: `0x${"cd".repeat(33)}`,
    ...overrides,
  } as Print;
}

const snapshot: PriceSnapshot = {
  snapshot_id: "snap-1",
  timestamp: "2026-08-14T00:00:00Z",
  source: "openrouter",
  entries: [{ model_id: "A", price_in_usd_per_1m: "1.00", price_out_usd_per_1m: "2.00" }],
};

describe("convertTool", () => {
  it("computes usd via callCost and siu via the print's own exchange rate", () => {
    const result = convertTool(
      { model: "A", input_tokens: 1000, output_tokens: 500 },
      fixturePrint(),
      snapshot,
    );
    expect(result.usd).toBe("0.002");
    expect(result.siu).toBe("0.02");
  });

  it("throws honestly when the model has no published exchange rate", () => {
    expect(() =>
      convertTool({ model: "Z", input_tokens: 1, output_tokens: 1 }, fixturePrint(), snapshot),
    ).toThrow(/no published exchange rate/);
  });

  it("throws honestly when the model has no price in the referenced snapshot", () => {
    const emptySnapshot: PriceSnapshot = {
      ...snapshot,
      entries: [{ ...snapshot.entries[0], model_id: "B" }],
    };
    expect(() =>
      convertTool({ model: "A", input_tokens: 1, output_tokens: 1 }, fixturePrint(), emptySnapshot),
    ).toThrow(/no price in the snapshot/);
  });

  it("surfaces the excluded_reason when a model was excluded from the exchange-rate table", () => {
    const excludedPrint = fixturePrint({
      exchange_rate_table: [{ model_id: "A", excluded_reason: "all instances failed" }],
    } as Partial<Print>);
    expect(() =>
      convertTool({ model: "A", input_tokens: 1, output_tokens: 1 }, excludedPrint, snapshot),
    ).toThrow(/all instances failed/);
  });
});
