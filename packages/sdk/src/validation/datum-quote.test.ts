import { describe, expect, it } from "vitest";
import { validateTouchstoneQuote } from "./datum-quote.js";

const validQuote = {
  schema_version: "1.0",
  siu: "1.000",
  pattern: "fixed",
  model: "anthropic-sonnet-5",
  rate_usd_per_siu: "0.0483",
  amount_usd_max: "0.0676",
  index_version: "SIU-2026a",
  print_id: "2026-08-14",
  print_hash: "0xabc123",
  seller_id: "erc8004:0xSellerAddress",
  expiry: "2026-08-16T00:00:00Z",
  settlement: [
    {
      asset: "usdc",
      chain: "base",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount_max: "67600",
    },
  ],
  sig: "0xdeadbeef",
};

describe("validateTouchstoneQuote", () => {
  it("accepts a valid fixed-pattern quote", () => {
    const result = validateTouchstoneQuote(validQuote);
    expect(result.valid).toBe(true);
  });

  it("rejects an estimate-pattern quote missing siu_max (normative per build1-spec.md §8)", () => {
    const result = validateTouchstoneQuote({ ...validQuote, pattern: "estimate" });
    expect(result.valid).toBe(false);
  });

  it("rejects amount_usd_max encoded as a JSON number instead of a decimal string", () => {
    const result = validateTouchstoneQuote({ ...validQuote, amount_usd_max: 0.0676 });
    expect(result.valid).toBe(false);
  });

  it("accepts an optional settler address (schema_version 1.1)", () => {
    const result = validateTouchstoneQuote({ ...validQuote, settler: `0x${"ab".repeat(20)}` });
    expect(result.valid).toBe(true);
  });

  it("rejects a settler that is not a 20-byte hex address", () => {
    const result = validateTouchstoneQuote({ ...validQuote, settler: "0xnope" });
    expect(result.valid).toBe(false);
  });
});
