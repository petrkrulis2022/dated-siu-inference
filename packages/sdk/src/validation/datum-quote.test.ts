import { describe, expect, it } from "vitest";
import { validateDatumQuote } from "./datum-quote.js";

const validQuote = {
  siu: "1.000",
  pattern: "fixed",
  model: "anthropic-sonnet-5",
  rate_usd_per_siu: "0.0483",
  amount_usd_max: "0.0676",
  index_version: "SIU-2026a",
  print_id: "2026-08-14",
  print_hash: "0xabc123",
  seller_id: "erc8004:0xSellerAddress",
  sig: "0xdeadbeef",
};

describe("validateDatumQuote", () => {
  it("accepts a valid fixed-pattern quote", () => {
    const result = validateDatumQuote(validQuote);
    expect(result.valid).toBe(true);
  });

  it("rejects an estimate-pattern quote missing siu_max (normative per build1-spec.md §8)", () => {
    const result = validateDatumQuote({ ...validQuote, pattern: "estimate" });
    expect(result.valid).toBe(false);
  });

  it("rejects amount_usd_max encoded as a JSON number instead of a decimal string", () => {
    const result = validateDatumQuote({ ...validQuote, amount_usd_max: 0.0676 });
    expect(result.valid).toBe(false);
  });
});
