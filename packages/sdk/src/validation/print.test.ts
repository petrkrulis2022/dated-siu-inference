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
  rounding: {
    dated_siu_dp: 4,
    basket_cost_dp: 6,
    usd_per_siu_dp: 4,
    spread_dp: 4,
    siu_per_usd_dp: 1,
    mode: "ROUND_HALF_UP",
    siu_per_usd_mode: "ROUND_DOWN",
  },
  cost_of_production_usd: "2.87",
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

  it("accepts a print with methodology_revision present — optional, forward-only", () => {
    const result = validatePrint({ ...validPrint, methodology_revision: "rules-2026-09-25" });
    expect(result.valid).toBe(true);
  });

  describe("anchor.additional_anchors (a second chain, best-effort)", () => {
    const base = { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"11".repeat(32)}`, posted_at: "2026-10-15T00:58:52.000Z" };
    it("accepts an anchor with no additional anchors, as every published print has", () => {
      expect(validatePrint({ ...validPrint, anchor: base }).valid).toBe(true);
    });
    it("accepts an Arc anchor that landed, one that failed with its reason, and one that was skipped", () => {
      for (const extra of [
        { chain: "arc-testnet", status: "anchored", tx_hash: `0x${"22".repeat(32)}`, posted_at: "2026-10-15T00:58:54.000Z" },
        { chain: "arc-testnet", status: "failed", notes: "timed out after 90s; the hash may still land and is checked again on the next run" },
        { chain: "arc-testnet", status: "skipped", notes: "publisher balance below the minimum for an anchor" },
        { chain: "arc-testnet", status: "already-anchored", posted_at: "2026-10-15T00:58:54.000Z" },
      ]) {
        expect(validatePrint({ ...validPrint, anchor: { ...base, additional_anchors: [extra] } }).valid, JSON.stringify(extra)).toBe(true);
      }
    });
    it("rejects an additional anchor with no chain, an unknown status (a stub is never an additional anchor), or an unknown field", () => {
      for (const bad of [{ status: "anchored" }, { chain: "arc-testnet", status: "stub" }, { chain: "arc-testnet", status: "anchored", rpc_url: "x" }]) {
        expect(validatePrint({ ...validPrint, anchor: { ...base, additional_anchors: [bad] } }).valid, JSON.stringify(bad)).toBe(false);
      }
    });
  });

  it("accepts a print with methodology_revision absent — every historical print stays valid", () => {
    // validPrint itself already omits it; asserted explicitly here so a future edit to validPrint
    // that accidentally adds it wouldn't silently stop covering this case.
    expect("methodology_revision" in validPrint).toBe(false);
    const result = validatePrint(validPrint);
    expect(result.valid).toBe(true);
  });

  it("accepts the current significant-figures rounding shape (dated_siu_sig_figs)", () => {
    const result = validatePrint({
      ...validPrint,
      rounding: {
        dated_siu_sig_figs: 4,
        basket_cost_dp: 6,
        usd_per_siu_dp: 4,
        spread_dp: 4,
        siu_per_usd_dp: 1,
        mode: "ROUND_HALF_UP",
        siu_per_usd_mode: "ROUND_DOWN",
      },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a rounding object carrying both dated_siu_dp and dated_siu_sig_figs at once", () => {
    const result = validatePrint({
      ...validPrint,
      rounding: { ...validPrint.rounding, dated_siu_sig_figs: 4 },
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a rounding object carrying neither dated_siu_dp nor dated_siu_sig_figs", () => {
    const result = validatePrint({
      ...validPrint,
      rounding: {
        basket_cost_dp: 6,
        usd_per_siu_dp: 4,
        spread_dp: 4,
        siu_per_usd_dp: 1,
        mode: "ROUND_HALF_UP",
        siu_per_usd_mode: "ROUND_DOWN",
      },
    });
    expect(result.valid).toBe(false);
  });
});
