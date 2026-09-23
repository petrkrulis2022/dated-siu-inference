import { describe, expect, it } from "vitest";
import { buildReceipt } from "./emit.js";
import { MECHANISM_CAVEAT } from "../skills/caveat.js";

function baseInput() {
  return {
    receiptId: "r1",
    parentPaymentId: null,
    quoteId: "q1",
    buyer: "ORCHESTRATOR" as const,
    seller: "WORKER-EXTRACT" as const,
    executor: "WORKER-EXTRACT" as const,
    taskClass: "extract" as const,
    siuDelivered: 10,
    gateResult: {
      g1: { passed: true, reason: "ok" },
      g2: { passed: true, reason: "ok" },
      g3: { passed: true, reason: "ok" },
      g4: { passed: true, reason: "ok" },
      g5: { passed: true, reason: "ok" },
      g6: { passed: true, reason: "ok" },
      passed: true,
    },
    settlementAsset: "usdc",
    settlementAmount: 10,
    usdcEquivalentAtPrint: "0.10",
    printId: "2026-09-22",
    methodologyVersion: "SIU-2026a",
    gateSpecHash: "0x0",
    adversarialCaseHashes: [],
  };
}

describe("buildReceipt — the mechanism-not-demand caveat (pre-WP-7 fix, spec §1.1)", () => {
  it("attaches the real caveat constant to every receipt, not something callers pass in", () => {
    const receipt = buildReceipt(baseInput());
    expect(receipt.mechanism_caveat).toBe(MECHANISM_CAVEAT);
  });

  it("attaches it identically regardless of pass or fail — the caveat isn't about the outcome", () => {
    const failing = buildReceipt({
      ...baseInput(),
      gateResult: {
        g1: { passed: true, reason: "ok" },
        g2: { passed: false, reason: "adversarial case accepted" },
        g3: { passed: true, reason: "ok" },
        g4: { passed: true, reason: "ok" },
        g5: { passed: true, reason: "ok" },
        g6: { passed: true, reason: "ok" },
        passed: false,
      },
    });
    expect(failing.mechanism_caveat).toBe(MECHANISM_CAVEAT);
    expect(failing.claim_retired).toBe(false);
  });
});
