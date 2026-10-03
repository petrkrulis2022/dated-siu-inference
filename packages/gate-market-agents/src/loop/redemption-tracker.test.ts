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

  it(
    "carries the presented task spec to the routed issuer, and to nobody else — without it the " +
      "issuer is told it owes a gate for a job it has never seen, which is why no issuer-authored " +
      "gate was ever valid before 2026-09-29",
    () => {
      const tracker = new RedemptionTracker();
      tracker.recordMint("1", "ISSUER-A", "500");
      tracker.recordPresented("WORKER-CODE", "THE FUNCTION UNDER TEST: dedupeSorted(arr)");

      const rendered = tracker.renderForIssuerAwaitingDelivery("ISSUER-A");
      expect(rendered).toContain("THE TASK THIS CLAIM WAS PRESENTED AGAINST");
      expect(rendered).toContain("THE FUNCTION UNDER TEST: dedupeSorted(arr)");
      // Only the routed issuer — the spec arrives with the claim, so an issuer with no claim
      // presented against it sees nothing at all.
      expect(tracker.renderForIssuerAwaitingDelivery("ISSUER-B")).toBe("");
      expect(tracker.state().taskSpecText).toBe("THE FUNCTION UNDER TEST: dedupeSorted(arr)");
    },
  );

  it(
    "omits the task-spec section entirely when none was presented, rather than printing an " +
      "empty heading",
    () => {
      const tracker = new RedemptionTracker();
      tracker.recordMint("1", "ISSUER-A", "500");
      tracker.recordPresented("WORKER-CODE");
      const rendered = tracker.renderForIssuerAwaitingDelivery("ISSUER-A");
      expect(rendered).toContain("tokenId 1");
      expect(rendered).not.toContain("THE TASK THIS CLAIM WAS PRESENTED AGAINST");
    },
  );

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

describe("the holder's side of a presented claim (spec §4.6ae)", () => {
  /** Presented at chain second 1000 with 400s of life left, so it expires at 1400 and the
   *  midpoint — "waited longer than you have left" — falls at 1200. */
  const presented = () => {
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordPresented("WORKER-CODE", undefined, { atChainSeconds: 1000, secondsToExpiry: 400 });
    return t;
  };

  it("says nothing to the holder while the issuer still legitimately owes the work", () => {
    // Run 16's holder waited here, correctly. This stage is not the defect.
    const t = presented();
    expect(t.renderServedForHolder("WORKER-CODE")).toBe("");
    expect(t.renderUnservedForHolder("WORKER-CODE", 1100)).toBe("");
  });

  it("tells the holder its claim was served, which nothing did before", () => {
    // The hole: renderForHolder goes empty at presentation and never returns, and every other
    // renderer is issuer-side. A served claim reached the holder through no channel at all.
    const t = presented();
    t.recordServed(true);
    const text = t.renderServedForHolder("WORKER-CODE");
    expect(text).toContain("YOUR CLAIM WAS SERVED");
    expect(text).toContain("The work passed");
    expect(text).toContain("77");
  });

  it("distinguishes a served FAIL from a served PASS — the holder's position is not the same", () => {
    const t = presented();
    t.recordServed(false);
    const text = t.renderServedForHolder("WORKER-CODE");
    expect(text).toContain("THE WORK DID NOT PASS");
    expect(text).toContain("you would have to buy again");
  });

  it("tells no one but the holder", () => {
    const t = presented();
    t.recordServed(true);
    expect(t.renderServedForHolder("ISSUER-A")).toBe("");
    expect(t.renderServedForHolder("WORKER-EXTRACT")).toBe("");
  });

  it("warns about an unserved claim only once the holder has waited longer than it has left", () => {
    const t = presented();
    expect(t.renderUnservedForHolder("WORKER-CODE", 1001)).toBe("");
    expect(t.renderUnservedForHolder("WORKER-CODE", 1199)).toBe("");
    // 1201: waited 201s, 199s remain. The midpoint is crossed.
    expect(t.renderUnservedForHolder("WORKER-CODE", 1201)).toContain("STILL UNSERVED");
  });

  it("shows the unserved warning once per claim, never once per round", () => {
    // §4.6ac: a standing fact nobody acts on must not wake its holder on every cursor. This is
    // the same bound `shownForwardOffers` already puts on the forward invitation.
    const t = presented();
    expect(t.renderUnservedForHolder("WORKER-CODE", 1300)).not.toBe("");
    t.markUnservedWarningShown();
    expect(t.renderUnservedForHolder("WORKER-CODE", 1300)).toBe("");
    expect(t.renderUnservedForHolder("WORKER-CODE", 1399)).toBe("");
  });

  it("stops warning once the claim is actually served", () => {
    const t = presented();
    t.recordServed(true);
    expect(t.renderUnservedForHolder("WORKER-CODE", 1300)).toBe("");
  });

  it("says nothing about the issuer, because the holder noticing is what the run measures", () => {
    // NON_SERVING_ISSUER exists so that non-delivery is discovered rather than announced. A
    // warning built from the issuer's refusals would hand the holder the answer; this one is
    // built only from when the holder presented and when its own claim expires.
    const t = presented();
    const text = t.renderUnservedForHolder("WORKER-CODE", 1300);
    expect(text).not.toContain("ISSUER-A");
    expect(text).not.toMatch(/refus|cannot serve|not permitted|withheld/i);
  });

  it("gives no timed warning at all when redeem_claim returned no expiry — never an invented one", () => {
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordPresented("WORKER-CODE");
    expect(t.renderUnservedForHolder("WORKER-CODE", 9_999_999)).toBe("");
  });
});
