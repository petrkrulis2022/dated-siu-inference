import { describe, expect, it } from "vitest";
import {
  assertChildPaymentsWithinParent,
  buildReceiptGraph,
  ChildPaymentsExceedParentError,
} from "./graph.js";
import type { GateMarketReceipt } from "./types.js";

function fakeReceipt(overrides: Partial<GateMarketReceipt>): GateMarketReceipt {
  return {
    receipt_id: "r1",
    parent_payment_id: null,
    quote_id: "q1",
    buyer: "ORCHESTRATOR",
    seller: "WORKER-EXTRACT",
    executor: "WORKER-EXTRACT",
    class: "extract",
    siu_delivered: 0,
    gate_results: { G1: true, G2: true, G3: true, G4: true, G5: true },
    settlement_asset: "usdc",
    settlement_amount: 0,
    usdc_equivalent_at_print: "0.00",
    print_id: "2026-09-22",
    methodology_version: "SIU-2026a",
    claim_retired: true,
    usage: { input_tokens: 0, output_tokens: 0, retries: 0 },
    artefact_hashes: { gate_spec: "0x0", adversarial_cases: [] },
    mechanism_caveat: "test fixture — not the real caveat text",
    ...overrides,
  };
}

describe("buildReceiptGraph / assertChildPaymentsWithinParent", () => {
  it("groups receipts by parent_payment_id", () => {
    const graph = buildReceiptGraph([
      fakeReceipt({ receipt_id: "c1", parent_payment_id: "job-1" }),
      fakeReceipt({ receipt_id: "c2", parent_payment_id: "job-1" }),
      fakeReceipt({ receipt_id: "c3", parent_payment_id: "job-2" }),
      fakeReceipt({ receipt_id: "root", parent_payment_id: null }),
    ]);
    expect(graph.get("job-1")).toHaveLength(2);
    expect(graph.get("job-2")).toHaveLength(1);
    expect(graph.has("root")).toBe(false); // the null-parent root itself is never a graph key
  });

  it("sums usdc_equivalent_at_print, not raw settlement_amount, across mixed settlement assets", () => {
    const graph = buildReceiptGraph([
      fakeReceipt({
        receipt_id: "c1",
        parent_payment_id: "job-1",
        settlement_asset: "usdc",
        settlement_amount: 40,
        usdc_equivalent_at_print: "0.0200",
      }),
      fakeReceipt({
        receipt_id: "c2",
        parent_payment_id: "job-1",
        settlement_asset: "fsiu:extract/2026-W40",
        settlement_amount: 40, // a completely different unit (mSIU) from c1's USDC — summing
        // this raw would be meaningless; the graph check must use each receipt's own
        // USD-equivalent instead.
        usdc_equivalent_at_print: "0.0180",
      }),
    ]);
    // 0.02 + 0.018 = 0.038, within a 0.05 parent — must not throw.
    expect(() => assertChildPaymentsWithinParent(graph, "job-1", "0.05")).not.toThrow();
    // Within a 0.038 parent exactly — must not throw (not strictly greater).
    expect(() => assertChildPaymentsWithinParent(graph, "job-1", "0.038")).not.toThrow();
    // Exceeds a 0.03 parent — must throw, naming the real sums.
    expect(() => assertChildPaymentsWithinParent(graph, "job-1", "0.03")).toThrow(
      ChildPaymentsExceedParentError,
    );
  });

  it("a parent with no children never exceeds any nonnegative parent amount", () => {
    const graph = buildReceiptGraph([]);
    expect(() => assertChildPaymentsWithinParent(graph, "job-none", "0.00")).not.toThrow();
  });
});
