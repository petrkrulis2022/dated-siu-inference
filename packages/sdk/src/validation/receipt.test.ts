import { describe, expect, it } from "vitest";
import { validateReceipt } from "./receipt.js";

const validReceipt = {
  schema_version: "1.0",
  quote_hash: `0x${"a".repeat(64)}`,
  chain: "base",
  tx_ref: `0x${"b".repeat(64)}`,
  amount_quoted_usd: "0.0676",
  amount_paid_usd: "0.0676",
  matched: true,
  print_ref: "2026-08-14",
  signature: `0x${"c".repeat(64)}`,
  public_key: `0x${"d".repeat(66)}`,
};

describe("validateReceipt", () => {
  it("accepts a valid receipt", () => {
    const result = validateReceipt(validReceipt);
    expect(result.valid).toBe(true);
  });

  it("rejects amount_paid_usd encoded as a JSON number instead of a decimal string", () => {
    const result = validateReceipt({ ...validReceipt, amount_paid_usd: 0.0676 });
    expect(result.valid).toBe(false);
  });

  it("rejects a quote_hash that isn't a full bytes32 hex string", () => {
    const result = validateReceipt({ ...validReceipt, quote_hash: "0x1234" });
    expect(result.valid).toBe(false);
  });
});
