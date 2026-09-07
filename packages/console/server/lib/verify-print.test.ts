import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { verifyPrintOnChain } from "./verify-print.js";

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
    signature: `0x${"1".repeat(128)}`,
    public_key: `0x${"2".repeat(66)}`,
    ...overrides,
  } as Print;
}

describe("verifyPrintOnChain", () => {
  it("reports a resolveOptions failure the same honest way a chain-read failure already is — never throws past the caller", async () => {
    const print = fakePrint();
    const result = await verifyPrintOnChain(print, () => {
      throw new Error("ARC_TESTNET_RPC_URL is not set — source .env before starting the console.");
    });
    expect(result.verified).toBe(false);
    expect(result.anchored).toBe(false);
    expect(result.error).toMatch(/ARC_TESTNET_RPC_URL/);
    // The print's own self-check (schema/signature) still runs — resolveOptions failing only
    // means the chain-side half of verification couldn't happen, not that nothing was checked.
    expect(result.schemaValid).toBe(true);
  });
});
