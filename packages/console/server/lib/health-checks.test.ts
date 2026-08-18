import { describe, expect, it } from "vitest";
import type { PriceSnapshot, Print } from "@touchstone/sdk";
import { computeHealthReport } from "./health-checks.js";

function fakePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-17",
    date: "2026-08-17",
    status: "provisional",
    basket_costs: [{ model_id: "m1", cost_usd: "0.01" }],
    weights: { source: "equal", values: [{ model_id: "m1", weight: "1" }] },
    dated_siu: "0.01",
    exchange_rate_table: [
      { model_id: "m1", usd_per_siu: "0.01", spread_to_index: "0", siu_per_usd: "100" },
    ],
    sensitivity_block: [{ policy_variant: "baseline", dated_siu: "0.01", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "3.00",
    price_snapshot_ref: "price-snapshot-openrouter-x.json",
    methodology_version: "v0",
    anchor: { chain: "base-sepolia", status: "anchored", tx_hash: "0xanchor" },
    signature: `0x${"1".repeat(128)}`,
    public_key: `0x${"2".repeat(66)}`,
    ...overrides,
  } as Print;
}

function fakeSnapshot(overrides: Partial<PriceSnapshot> = {}): PriceSnapshot {
  return {
    snapshot_id: "s1",
    timestamp: "2026-08-17T00:00:00.000Z",
    source: "openrouter",
    entries: [{ model_id: "m1", price_in_usd_per_1m: "1", price_out_usd_per_1m: "2" }],
    ...overrides,
  } as PriceSnapshot;
}

describe("computeHealthReport", () => {
  it("reports no issues for a clean, current, anchored, final state", () => {
    const print = fakePrint({ status: "final" });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: fakeSnapshot(),
      publisherEthBalanceWei: "1000000000000000000",
    });
    expect(report.latestPrint).toEqual({ print_id: "2026-08-17", date: "2026-08-17" });
    expect(report.gateFailuresInLatestPrint).toHaveLength(0);
    expect(report.subsidisedModels).toHaveLength(0);
    expect(report.unanchoredPrints).toHaveLength(0);
    expect(report.staleProvisionalPrints).toHaveLength(0);
  });

  it("flags a model excluded from the latest print's reference set", () => {
    const print = fakePrint({
      exchange_rate_table: [{ model_id: "m2", excluded_reason: "all instances failed T3" }],
    });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: null,
      publisherEthBalanceWei: "0",
    });
    expect(report.gateFailuresInLatestPrint).toEqual([
      { print_id: "2026-08-17", model_id: "m2", reason: "all instances failed T3" },
    ]);
  });

  it("flags snapshot entries marked subsidised", () => {
    const snapshot = fakeSnapshot({
      entries: [
        {
          model_id: "m1",
          price_in_usd_per_1m: "0.01",
          price_out_usd_per_1m: "0.01",
          subsidised: true,
        },
      ],
    });
    const report = computeHealthReport({
      prints: [],
      latestPriceSnapshot: snapshot,
      publisherEthBalanceWei: "0",
    });
    expect(report.subsidisedModels).toEqual([
      { model_id: "m1", price_in_usd_per_1m: "0.01", price_out_usd_per_1m: "0.01" },
    ]);
  });

  it("flags a price snapshot older than the latest print", () => {
    const print = fakePrint({ date: "2026-08-20" });
    const snapshot = fakeSnapshot({ timestamp: "2026-08-10T00:00:00.000Z" });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: snapshot,
      publisherEthBalanceWei: "0",
    });
    expect(report.priceSnapshotIsStale).toBe(true);
  });

  it("flags a print with anchor.status other than anchored/already-anchored", () => {
    const print = fakePrint({ anchor: { chain: "base-sepolia", status: "failed" } });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: null,
      publisherEthBalanceWei: "0",
    });
    expect(report.unanchoredPrints).toEqual([
      { print_id: "2026-08-17", date: "2026-08-17", anchorStatus: "failed" },
    ]);
  });

  it("flags a provisional print older than the reconciliation window", () => {
    const print = fakePrint({ status: "provisional", date: "2026-08-01" });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: null,
      publisherEthBalanceWei: "0",
      now: new Date("2026-08-17T00:00:00.000Z"),
      reconciliationWindowDays: 7,
    });
    expect(report.staleProvisionalPrints).toEqual([
      { print_id: "2026-08-17", date: "2026-08-01", daysSincePublished: 16 },
    ]);
  });

  it("does not flag a recently-provisional print within the window", () => {
    const print = fakePrint({ status: "provisional", date: "2026-08-15" });
    const report = computeHealthReport({
      prints: [print],
      latestPriceSnapshot: null,
      publisherEthBalanceWei: "0",
      now: new Date("2026-08-17T00:00:00.000Z"),
      reconciliationWindowDays: 7,
    });
    expect(report.staleProvisionalPrints).toHaveLength(0);
  });
});
