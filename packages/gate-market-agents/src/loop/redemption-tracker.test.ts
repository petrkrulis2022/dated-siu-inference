import { describe, expect, it } from "vitest";
import { RedemptionTracker } from "./redemption-tracker.js";

describe("RedemptionTracker", () => {
  it("shows nothing to any agent until every real fact is known", () => {
    const tracker = new RedemptionTracker();
    expect(tracker.renderFor("ISSUER-A")).toBe("");

    tracker.recordMint("1", "ISSUER-A", "500");
    expect(tracker.renderFor("ISSUER-A")).toBe("");

    tracker.recordPresented("WORKER-CODE");
    expect(tracker.renderFor("ISSUER-A")).toBe("");
  });

  it("shows the pending redemption to the routed issuer only, once every fact is in", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    tracker.recordPresented("WORKER-CODE");
    tracker.recordGraded(true, "0xreceipt");

    expect(tracker.renderFor("ISSUER-A")).toContain("tokenId 1");
    expect(tracker.renderFor("ISSUER-A")).toContain("holder WORKER-CODE");
    expect(tracker.renderFor("ISSUER-A")).toContain("passed=true");
    // Never shown to a different agent, even the holder itself.
    expect(tracker.renderFor("ISSUER-B")).toBe("");
    expect(tracker.renderFor("WORKER-CODE")).toBe("");
  });

  it("stops showing once served, so an issuer never double-serves off a stale board view", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    tracker.recordPresented("WORKER-CODE");
    tracker.recordGraded(true, "0xreceipt");
    expect(tracker.renderFor("ISSUER-A")).not.toBe("");

    tracker.recordServed();
    expect(tracker.renderFor("ISSUER-A")).toBe("");
    expect(tracker.state().served).toBe(true);
  });
});
