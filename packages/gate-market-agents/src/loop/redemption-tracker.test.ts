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

  it("renderForHolder tells the real recipient of a transfer its tokenId, and only that agent", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    expect(tracker.renderForHolder("WORKER-CODE")).toBe("");

    tracker.recordTransfer("WORKER-CODE");
    expect(tracker.renderForHolder("WORKER-CODE")).toContain("tokenId 1");
    expect(tracker.renderForHolder("WORKER-CODE")).toContain("quantity 500");
    expect(tracker.renderForHolder("ISSUER-A")).toBe("");
  });

  it("renderForHolder stops once the holder has actually presented the claim", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    tracker.recordTransfer("WORKER-CODE");
    expect(tracker.renderForHolder("WORKER-CODE")).not.toBe("");

    tracker.recordPresented("WORKER-CODE");
    expect(tracker.renderForHolder("WORKER-CODE")).toBe("");
  });

  it("renderForIssuerAwaitingDelivery tells the routed issuer it owes real work, once presented", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    expect(tracker.renderForIssuerAwaitingDelivery("ISSUER-A")).toBe(""); // not presented yet

    tracker.recordPresented("WORKER-CODE");
    const rendered = tracker.renderForIssuerAwaitingDelivery("ISSUER-A");
    expect(rendered).toContain("tokenId 1");
    expect(rendered).toContain("holder WORKER-CODE");
    expect(rendered).toContain("quantity 500");
    // Never shown to anyone else, including the holder itself.
    expect(tracker.renderForIssuerAwaitingDelivery("ISSUER-B")).toBe("");
    expect(tracker.renderForIssuerAwaitingDelivery("WORKER-CODE")).toBe("");
  });

  it("renderForIssuerAwaitingDelivery stops once a genuine pass is in — renderFor takes over", () => {
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    tracker.recordPresented("WORKER-CODE");
    expect(tracker.renderForIssuerAwaitingDelivery("ISSUER-A")).not.toBe("");

    tracker.recordGraded(true, "0xreceipt");
    expect(tracker.renderForIssuerAwaitingDelivery("ISSUER-A")).toBe("");
    expect(tracker.renderFor("ISSUER-A")).not.toBe("");
  });

  it("recordGraded(false, ...) is a real no-op — a failing attempt never becomes ready to serve", () => {
    // Found live, 2026-09-26 (P5 window 1): redemption grades the routed issuer's own delivery,
    // never the holder's — a failing attempt is not terminal, only a genuine pass ever is. See
    // data/gate-market/first-real-default-2026-09-26.json for the real incident this fixes.
    const tracker = new RedemptionTracker();
    tracker.recordMint("1", "ISSUER-A", "500");
    tracker.recordPresented("WORKER-CODE");
    tracker.recordGraded(false, "0xreceipt-fail");

    expect(tracker.renderFor("ISSUER-A")).toBe("");
    expect(tracker.state().passed).toBeUndefined();
    expect(tracker.state().receiptRef).toBeUndefined();

    // A later genuine pass still works normally — failing first does not poison the claim.
    tracker.recordGraded(true, "0xreceipt-pass");
    expect(tracker.renderFor("ISSUER-A")).toContain("passed=true");
  });
});
