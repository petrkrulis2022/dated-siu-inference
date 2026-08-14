import { describe, expect, it } from "vitest";
import { validatePrint } from "./print.js";

const validPrint = {
  version: "SIU-2026a",
  print_id: "2026-08-14",
  date: "2026-08-14",
  status: "provisional",
  basket_costs: [{ model_id: "anthropic-sonnet-5", cost_usd: "0.0383" }],
  weights: {
    source: "equal",
    values: [{ model_id: "anthropic-sonnet-5", weight: "1.0" }],
  },
  dated_siu: "0.0383",
  exchange_rate_table: [
    {
      model_id: "anthropic-sonnet-5",
      usd_per_siu: "0.0383",
      spread_to_index: "0",
      siu_per_usd: "26.11",
    },
  ],
  floor: { value: "0.0100", notes: "vLLM reference config" },
  market_spread: "3.83",
  sensitivity_block: [{ policy_variant: "cache-enabled", dated_siu: "0.0350", delta: "-0.0033" }],
  price_snapshot_ref: "2026-08-14T00:00:00Z-openrouter",
  methodology_version: "v0",
  signature: "0xabc123",
  public_key: "0xdeadbeef",
};

describe("validatePrint", () => {
  it("accepts a valid print", () => {
    const result = validatePrint(validPrint);
    expect(result.valid).toBe(true);
  });

  it("rejects dated_siu encoded as a JSON number instead of a decimal string", () => {
    const result = validatePrint({ ...validPrint, dated_siu: 0.0383 });
    expect(result.valid).toBe(false);
  });

  it("rejects an out-of-enum status", () => {
    const result = validatePrint({ ...validPrint, status: "draft" });
    expect(result.valid).toBe(false);
  });
});
