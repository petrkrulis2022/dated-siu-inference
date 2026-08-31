import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { partitionBySeries } from "./build.js";

function print(overrides: Partial<Print>): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-31",
    date: "2026-08-31",
    status: "provisional",
    basket_costs: [],
    weights: { source: "equal", values: [] },
    dated_siu: "0.0015",
    exchange_rate_table: [],
    sensitivity_block: [],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 4,
      mode: "half-up",
      siu_per_usd_mode: "half-up",
    },
    price_snapshot_ref: "merged-2026-08-31.json",
    methodology_version: "v0-draft",
    cost_of_production_usd: "0.10",
    signature: "0xabc",
    public_key: "0xdef",
    ...overrides,
  } as Print;
}

describe("partitionBySeries", () => {
  it("puts a print with no series field into the blended Dated SIU group", () => {
    const p = print({});
    expect(partitionBySeries([p])).toEqual({ dated: [p], commodity: [], frontier: [] });
  });

  it("sorts commodity and frontier prints into their own groups", () => {
    const dated = print({ print_id: "2026-08-31" });
    const commodity = print({ print_id: "2026-08-31-commodity", series: "commodity" });
    const frontier = print({ print_id: "2026-08-31-frontier", series: "frontier" });
    expect(partitionBySeries([dated, commodity, frontier])).toEqual({
      dated: [dated],
      commodity: [commodity],
      frontier: [frontier],
    });
  });

  it("returns all-empty groups for an empty input, rather than throwing", () => {
    expect(partitionBySeries([])).toEqual({ dated: [], commodity: [], frontier: [] });
  });
});
