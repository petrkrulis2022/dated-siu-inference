import { describe, expect, it } from "vitest";
import { validateReconciliation } from "./reconciliation.js";

const validRecord = {
  schema_version: "1.0",
  print_id: "2026-09-09",
  computed_usd: "0.0886",
  invoice_usd: "0.0886",
  provider_breakdown: [
    { provider: "openrouter", invoice_usd: "0.005677" },
    { provider: "anthropic", invoice_usd: "0.031015" },
    { provider: "openai", invoice_usd: "0.014362" },
    { provider: "google", invoice_usd: "0.020406" },
    { provider: "xai", invoice_usd: "0.017140" },
  ],
  relative_delta: "0",
  tolerance: "0.02",
  reconciled_at: "2026-09-12T00:00:00Z",
  signature: `0x${"a".repeat(128)}`,
  public_key: `0x${"b".repeat(66)}`,
  anchor: { chain: "base-sepolia", status: "anchored", tx_hash: `0x${"c".repeat(64)}` },
};

describe("validateReconciliation", () => {
  it("accepts a valid reconciliation record", () => {
    const result = validateReconciliation(validRecord);
    expect(result.valid).toBe(true);
  });

  it("rejects invoice_usd encoded as a JSON number instead of a decimal string", () => {
    const result = validateReconciliation({ ...validRecord, invoice_usd: 0.0886 });
    expect(result.valid).toBe(false);
  });

  it("rejects an empty provider_breakdown", () => {
    const result = validateReconciliation({ ...validRecord, provider_breakdown: [] });
    expect(result.valid).toBe(false);
  });

  it("accepts a record with no anchor yet — optional so it can be signed before anchoring", () => {
    const withoutAnchor: Record<string, unknown> = { ...validRecord };
    delete withoutAnchor.anchor;
    const result = validateReconciliation(withoutAnchor);
    expect(result.valid).toBe(true);
  });

  it("rejects an unknown anchor status", () => {
    const result = validateReconciliation({
      ...validRecord,
      anchor: { ...validRecord.anchor, status: "pending" },
    });
    expect(result.valid).toBe(false);
  });
});
