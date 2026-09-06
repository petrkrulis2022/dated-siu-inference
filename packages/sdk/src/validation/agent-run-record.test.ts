import { describe, expect, it } from "vitest";
import { validateAgentRunRecord } from "./agent-run-record.js";

const validSellerRecord = {
  schema_version: "1.0",
  run_id: "11111111-1111-1111-1111-111111111111",
  captured_at: "2026-09-06T00:00:00.000Z",
  role: "seller",
  chain: "base-sepolia",
  quote_hash: `0x${"a".repeat(64)}`,
  methodology_version: "SIU-2026a-illustrative-demo",
  model: "openai/gpt-4o-mini",
  provider: "openrouter",
  routing_decision: "pinned",
  usage: { input: 120, output: 40, cached_input: 0, reasoning: 0 },
  latency_ms: 850,
  retry_count: 0,
  fallback_count: null,
  tool_calls: null,
  tool_failures: null,
  quality_gate_result: null,
  human_review_required: null,
  quoted_siu: "1.000000",
  actual_siu: "0.913200",
  usdc_paid: "0.0456",
  task_spec_hash: `0x${"b".repeat(64)}`,
  receipt_hash: `0x${"c".repeat(64)}`,
  verify_receipt_matched: null,
  chosen_seller_label: null,
};

const validBuyerRecord = {
  ...validSellerRecord,
  role: "buyer",
  provider: null,
  routing_decision: null,
  retry_count: null,
  task_spec_hash: null,
  verify_receipt_matched: true,
  chosen_seller_label: "seller-a",
};

describe("validateAgentRunRecord", () => {
  it("accepts a valid seller record with genuinely-nullable fields present as null", () => {
    expect(validateAgentRunRecord(validSellerRecord).valid).toBe(true);
  });

  it("accepts a valid buyer record with its own, different nullable fields", () => {
    expect(validateAgentRunRecord(validBuyerRecord).valid).toBe(true);
  });

  it("rejects a record missing a nullable field entirely rather than stating it as null", () => {
    const withoutFallbackCount: Partial<typeof validSellerRecord> = { ...validSellerRecord };
    delete withoutFallbackCount.fallback_count;
    expect(validateAgentRunRecord(withoutFallbackCount).valid).toBe(false);
  });

  it("rejects usdc_paid encoded as a JSON number instead of a decimal string", () => {
    expect(validateAgentRunRecord({ ...validSellerRecord, usdc_paid: 0.0456 }).valid).toBe(false);
  });

  it("rejects a quote_hash that isn't a full bytes32 hex string", () => {
    expect(validateAgentRunRecord({ ...validSellerRecord, quote_hash: "0x1234" }).valid).toBe(
      false,
    );
  });

  it("rejects an unrecognised role", () => {
    expect(validateAgentRunRecord({ ...validSellerRecord, role: "observer" }).valid).toBe(false);
  });
});
