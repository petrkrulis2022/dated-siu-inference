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

    tracker.recordServed(true);
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

describe("an unpresented claim's deadline and the memo (fsiu-design.md §4.3a)", () => {
  /** Arrives at chain second 1000 with 400s of life, so it expires at 1400 and the
   *  held-longer-than-remaining midpoint falls at 1200. */
  const arrived = (memo?: string) => {
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordTransfer("WORKER-CODE", memo);
    t.recordExpiry("77", 1400, 1000);
    return t;
  };

  it("puts the claim's own deadline in the arrival notice", () => {
    // Run 17's notice carried a tokenId and a quantity and nothing else. The holder knew the
    // rule — the shared facts say an unpresented claim "expires and pays nothing" — and had no
    // way to tell how long it had, so it planned to spend the claim "later" and lost it.
    expect(arrived().renderForHolder("WORKER-CODE", 1100)).toContain("closes in 300s");
  });

  it("still renders without a clock rather than inventing a deadline", () => {
    const text = arrived().renderForHolder("WORKER-CODE");
    expect(text).toContain("A WORK CLAIM WAS TRANSFERRED TO YOU");
    expect(text).not.toMatch(/closes in/);
  });

  it("quotes the payer's memo, and says nothing at all when there was none", () => {
    expect(arrived("for the window-1 code gate").renderForHolder("WORKER-CODE", 1100)).toContain(
      'The sender said what it is for: "for the window-1 code gate"',
    );
    expect(arrived().renderForHolder("WORKER-CODE", 1100)).not.toMatch(/sender said/);
  });

  it("treats a blank memo as no memo — never an empty quotation", () => {
    expect(arrived("   ").renderForHolder("WORKER-CODE", 1100)).not.toMatch(/sender said/);
  });

  it("warns only once the holder has held it longer than it has left", () => {
    const t = arrived();
    expect(t.renderUnpresentedLapsingForHolder("WORKER-CODE", 1199)).toBe("");
    expect(t.renderUnpresentedLapsingForHolder("WORKER-CODE", 1201)).toContain("ITS WINDOW IS CLOSING");
  });

  it("states the consequence that actually differs: expires paying nothing", () => {
    const text = arrived().renderUnpresentedLapsingForHolder("WORKER-CODE", 1300);
    expect(text).toMatch(/never presented simply expires/);
    expect(text).toMatch(/pays nothing/);
    // And leaves inaction genuinely open — the choice is the measurement.
    expect(text).toMatch(/including nothing, is yours to decide/);
  });

  it("says nothing about the issuer, so the holder noticing stays the thing measured", () => {
    const text = arrived().renderUnpresentedLapsingForHolder("WORKER-CODE", 1300);
    expect(text).not.toContain("ISSUER-A");
    expect(text).not.toMatch(/refus|cannot serve|withheld/i);
  });

  it("stops once the claim is presented — that stage has its own section", () => {
    const t = arrived();
    t.recordPresented("WORKER-CODE", undefined, { atChainSeconds: 1100, secondsToExpiry: 300 });
    expect(t.renderUnpresentedLapsingForHolder("WORKER-CODE", 1300)).toBe("");
  });

  it("shows the lapsing warning once per claim", () => {
    const t = arrived();
    expect(t.renderUnpresentedLapsingForHolder("WORKER-CODE", 1300)).not.toBe("");
    t.markLapsingWarningShown();
    expect(t.renderUnpresentedLapsingForHolder("WORKER-CODE", 1300)).toBe("");
  });

  it("ignores another claim's expiry rather than overwriting this one's", () => {
    const t = arrived();
    t.recordExpiry("999", 9_999_999, 1100);
    expect(t.renderForHolder("WORKER-CODE", 1100)).toContain("closes in 300s");
  });
});

describe("every stage of a claim's life either addresses the holder or is deliberately silent", () => {
  /**
   * The test that would have caught §4.6ae before a run did.
   *
   * The original defect was not a wrong renderer; it was a MISSING one, and nothing failed
   * when it was missing because no test asked "is there a renderer for this stage at all?".
   * Run 16 spent $3 discovering that a holder hears nothing after presenting. This walks the
   * whole lifecycle and requires each stage to be either covered or explicitly, named-in-code
   * silent — so adding a stage without a channel fails here rather than in a live run.
   */
  const HOLDER = "WORKER-CODE";
  const stage = (
    name: string,
    build: (t: RedemptionTracker) => void,
    expectation: "addresses the holder" | "deliberately silent",
    /** Each stage carries its own clock: "presented and still working" and "presented and
     *  overdue" are the SAME state at different times, and a single shared `now` silently
     *  turns the first into the second. */
    now: number,
    why?: string,
  ) => ({ name, build, expectation, now, why });

  const STAGES = [
    stage("transferred, not yet presented", (t) => {
      t.recordTransfer(HOLDER);
      t.recordExpiry("77", 1400, 1000);
    }, "addresses the holder", 1100),
    stage("held too long, window closing", (t) => {
      t.recordTransfer(HOLDER);
      t.recordExpiry("77", 1400, 1000);
    }, "addresses the holder", 1300),
    stage(
      "presented, issuer still legitimately working",
      (t) => {
        t.recordTransfer(HOLDER);
        t.recordPresented(HOLDER, undefined, { atChainSeconds: 1000, secondsToExpiry: 400 });
      },
      "deliberately silent",
      1100,
      "nothing is owed to the holder yet and it has nothing new it could do; waking it here is §4.6ac",
    ),
    stage("presented, overdue", (t) => {
      t.recordTransfer(HOLDER);
      t.recordPresented(HOLDER, undefined, { atChainSeconds: 1000, secondsToExpiry: 400 });
    }, "addresses the holder", 1300),
    stage("served, passed", (t) => {
      t.recordTransfer(HOLDER);
      t.recordPresented(HOLDER, undefined, { atChainSeconds: 1000, secondsToExpiry: 400 });
      t.recordServed(true);
    }, "addresses the holder", 1300),
    stage("served, failed", (t) => {
      t.recordTransfer(HOLDER);
      t.recordPresented(HOLDER, undefined, { atChainSeconds: 1000, secondsToExpiry: 400 });
      t.recordServed(false);
    }, "addresses the holder", 1300),
  ];

  for (const s of STAGES) {
    it(`${s.name}: ${s.expectation}`, () => {
      const t = new RedemptionTracker();
      t.recordMint("77", "ISSUER-A", "10000");
      s.build(t);
      const now = s.now;
      const said = [
        t.renderForHolder(HOLDER, now),
        t.renderUnpresentedLapsingForHolder(HOLDER, now),
        t.renderUnservedForHolder(HOLDER, now),
        t.renderServedForHolder(HOLDER),
      ].filter(Boolean);
      if (s.expectation === "addresses the holder") {
        expect(said.length, `no renderer addresses a holder at: ${s.name}`).toBeGreaterThan(0);
      } else {
        expect(said, `${s.name} should be silent because ${s.why}`).toEqual([]);
      }
    });
  }

  it("never addresses an agent that is not the holder, at any stage", () => {
    for (const s of STAGES) {
      const t = new RedemptionTracker();
      t.recordMint("77", "ISSUER-A", "10000");
      s.build(t);
      for (const other of ["ISSUER-A", "ISSUER-B", "ORCHESTRATOR", "WORKER-EXTRACT"] as const) {
        const said = [
          t.renderForHolder(other, s.now),
          t.renderUnpresentedLapsingForHolder(other, s.now),
          t.renderUnservedForHolder(other, s.now),
          t.renderServedForHolder(other),
        ].filter(Boolean);
        expect(said, `${s.name} leaked to ${other}`).toEqual([]);
      }
    }
  });
});

describe("the arrival notice names the quote a claim settles", () => {
  it("says which quote it settles, from the loop's own record", () => {
    // Run 17's holder asked, in its friction log, "whether this claim was meant as payment for a
    // gate-authoring job I'm expected to produce, or is simply an independent position". Once
    // every claim payment settles a quote the answer is structural, so it is not left to the
    // payer to volunteer it in a memo.
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordTransfer("WORKER-CODE", undefined, "qr-3");
    expect(t.renderForHolder("WORKER-CODE")).toContain("It settles your quote qr-3.");
  });

  it("says nothing about a quote when the claim was not settling one", () => {
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordTransfer("WORKER-CODE");
    expect(t.renderForHolder("WORKER-CODE")).not.toMatch(/settles your quote/);
  });

  it("keeps the memo and the quote independent", () => {
    const t = new RedemptionTracker();
    t.recordMint("77", "ISSUER-A", "10000");
    t.recordTransfer("WORKER-CODE", "gate for window 3", "qr-1");
    const text = t.renderForHolder("WORKER-CODE");
    expect(text).toContain("It settles your quote qr-1.");
    expect(text).toContain('The sender said what it is for: "gate for window 3"');
  });
});

describe("more than one claim, and more than one holder of a claim", () => {
  // Found by the first scripted walk on a fork of the real chain (2026-10-05). The tracker was a
  // single slot: one claim, one holder, the quantity minted. A claim passed on in part left its first
  // holder with a remainder nobody was told about — so it was never presented, never served — and
  // the second holder's share was invisible to everything downstream. Two claims in one window, which
  // is what two buyers paying in fSIU produce, overwrote each other outright.
  const NOW = 1_000;

  it("tells BOTH holders of a split claim what they hold, each its own quantity", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, "qr-1", { tokenId: "1", quantity: "10021" });
    t.recordTransfer("WORKER-EXTRACT", undefined, "qr-2", { tokenId: "1", quantity: "3967", from: "WORKER-CODE" });

    expect(t.renderForHolder("WORKER-CODE", NOW)).toContain("tokenId 1, quantity 6054");
    expect(t.renderForHolder("WORKER-CODE", NOW)).toContain("It settles your quote qr-1.");
    expect(t.renderForHolder("WORKER-EXTRACT", NOW)).toContain("tokenId 1, quantity 3967");
    expect(t.renderForHolder("WORKER-EXTRACT", NOW)).toContain("It settles your quote qr-2.");
  });

  it("stops telling a holder about a claim it has passed on in full", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "5000");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "5000" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "5000", from: "WORKER-CODE" });
    expect(t.renderForHolder("WORKER-CODE", NOW)).toBe("");
    expect(t.renderForHolder("WORKER-EXTRACT", NOW)).toContain("quantity 5000");
  });

  it("tells an issuer to serve exactly what a holder PRESENTED — its balance then, not what was minted", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "10021" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "3967", from: "WORKER-CODE" });
    t.recordPresented("WORKER-CODE", "the task", undefined, "1");

    expect(t.renderForIssuerAwaitingDelivery("ISSUER-B")).toContain("tokenId 1, holder WORKER-CODE, quantity 6054.");
    t.recordGraded(true, "0xreceipt", "ISSUER-B");
    expect(t.renderFor("ISSUER-B")).toContain("tokenId 1, holder WORKER-CODE, quantity 6054, real graded result: passed=true");
    // The other holder's share was never presented: nothing is owed on it.
    expect(t.renderFor("ISSUER-B")).not.toContain("WORKER-EXTRACT");
  });

  it("serves one holder's position without touching the other's", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "10021" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "3967", from: "WORKER-CODE" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    t.recordPresented("WORKER-EXTRACT", "spec", undefined, "1");
    t.recordGraded(true, "0xr", "ISSUER-B");
    t.recordServed(true, { tokenId: "1", holder: "WORKER-CODE", quantity: "6054" });

    const pending = t.renderFor("ISSUER-B");
    expect(pending).toContain("holder WORKER-EXTRACT, quantity 3967");
    expect(pending).not.toContain("holder WORKER-CODE");
    expect(t.renderServedForHolder("WORKER-CODE")).toContain("YOUR CLAIM WAS SERVED");
    expect(t.renderServedForHolder("WORKER-EXTRACT")).toBe("");
  });

  it("keeps a part-served position owed for what is left", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "1000");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "1000" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    t.recordGraded(true, "0xr", "ISSUER-B");
    t.recordServed(true, { tokenId: "1", holder: "WORKER-CODE", quantity: "400" });
    expect(t.renderFor("ISSUER-B")).toContain("quantity 600");
    expect(t.anyUnserved()).toBe(true);
    t.recordServed(true, { tokenId: "1", holder: "WORKER-CODE", quantity: "600" });
    expect(t.renderFor("ISSUER-B")).toBe("");
    expect(t.anyUnserved()).toBe(false);
  });

  it("keeps two claims apart: the second does not overwrite the first", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, "qr-1", { tokenId: "1", quantity: "10021" });
    t.recordMint("2", "ISSUER-B", "3967");
    t.recordTransfer("WORKER-EXTRACT", undefined, "qr-2", { tokenId: "2", quantity: "3967" });

    expect(t.renderForHolder("WORKER-CODE", NOW)).toContain("tokenId 1, quantity 10021");
    expect(t.renderForHolder("WORKER-EXTRACT", NOW)).toContain("tokenId 2, quantity 3967");
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    expect(t.renderForIssuerAwaitingDelivery("ISSUER-B")).toContain("tokenId 1, holder WORKER-CODE, quantity 10021");
    expect(t.renderForIssuerAwaitingDelivery("ISSUER-B")).not.toContain("tokenId 2");
  });

  it("lets a holder who holds two claims present each by its own token", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-A", "100");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "100" });
    t.recordMint("2", "ISSUER-B", "200");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "2", quantity: "200" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "2");
    expect(t.renderForIssuerAwaitingDelivery("ISSUER-B")).toContain("tokenId 2, holder WORKER-CODE, quantity 200");
    expect(t.renderForIssuerAwaitingDelivery("ISSUER-A")).toBe("");
    // The unpresented claim is still the holder's to be told about.
    expect(t.renderForHolder("WORKER-CODE", NOW)).toContain("tokenId 1, quantity 100");
    expect(t.renderForHolder("WORKER-CODE", NOW)).not.toContain("tokenId 2");
  });

  it("lists every position still owed to anyone, with whether it was presented, for settlement after close", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "10021" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "3967", from: "WORKER-CODE" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    expect(t.positions()).toEqual([
      { tokenId: "1", holder: "WORKER-CODE", issuer: "ISSUER-B", quantity: "6054", presented: true },
      { tokenId: "1", holder: "WORKER-EXTRACT", issuer: "ISSUER-B", quantity: "3967", presented: false },
    ]);
  });

  it("debits only what a holder has — a transfer larger than its position is a gap in the record, not a negative", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "100");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "100" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "250", from: "WORKER-CODE" });
    expect(t.positions().find((p) => p.holder === "WORKER-CODE")).toBeUndefined();
  });

  it("does not let a holder author the gate while it holds ANY live claim for the job, but lets the routed issuer", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "100");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "100" });
    expect(t.viewFor("WORKER-CODE").tokenId).toBe("1");
    expect(t.viewFor("WORKER-CODE").issuerAgentId).toBe("ISSUER-B");
    expect(t.viewFor("ISSUER-B").issuerAgentId).toBe("ISSUER-B");
    expect(t.viewFor("ORCHESTRATOR")).toEqual({ served: false });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "100", from: "WORKER-CODE" });
    // WORKER-CODE passed all of it on: no longer standing on a live claim.
    expect(t.viewFor("WORKER-CODE")).toEqual({ served: false });
  });

  it("reports a served FAIL to the holder it was served to, and only that holder", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "100");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "100" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    t.recordServed(false, { tokenId: "1", holder: "WORKER-CODE", quantity: "100" });
    expect(t.servedFailureFor("WORKER-CODE")).toBe(true);
    expect(t.servedFailureFor("WORKER-EXTRACT")).toBe(false);
  });

  it("describes each position a holder has for the check_delivery tool", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "10021" });
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "1", quantity: "3967", from: "WORKER-CODE" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    expect(t.deliveryFor("WORKER-CODE")).toEqual([
      { tokenId: "1", state: "presented_awaiting_issuer", issuer: "ISSUER-B", quantityMilliSiu: "6054" },
    ]);
    expect(t.deliveryFor("WORKER-EXTRACT")).toEqual([
      { tokenId: "1", state: "not_presented", issuer: "ISSUER-B", quantityMilliSiu: "3967" },
    ]);
  });

  it("lists what an issuer is owed, per presented position, graded or not", () => {
    const t = new RedemptionTracker();
    t.recordMint("1", "ISSUER-B", "10021");
    t.recordTransfer("WORKER-CODE", undefined, undefined, { tokenId: "1", quantity: "10021" });
    t.recordPresented("WORKER-CODE", "spec", undefined, "1");
    expect(t.presentedAgainst("ISSUER-B")).toEqual([
      { tokenId: "1", holder: "WORKER-CODE", quantity: "10021", graded: false },
    ]);
    t.recordGraded(true, "0xr", "ISSUER-B");
    expect(t.presentedAgainst("ISSUER-B")[0].graded).toBe(true);
    expect(t.presentedAgainst("ISSUER-A")).toEqual([]);
  });
});

describe("the tracker and the claim ledger are two books of one set of events, and agree", () => {
  // Two independent records of who holds what, built from the same events in the same order: the
  // ledger the decision rule is stated in, and the tracker every notice an agent reads is built from.
  // If they ever disagree, one of them is telling an agent something false.
  const AGENTS = ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT"] as const;
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("hold the same balances after a random run of mints and transfers (seed %i)", async (seed) => {
    const { ClaimLedger } = await import("./claim-ledger.js");
    const rand = mulberry(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
    const ledger = new ClaimLedger();
    const tracker = new RedemptionTracker();
    const address = (a: string): string => `0x${a}`;
    const resolve = (addr: string): (typeof AGENTS)[number] | undefined => AGENTS.find((a) => address(a) === addr);
    const held = new Map<string, bigint>(); // `${agent}|${token}` -> the test's own count
    const key = (a: string, t: string): string => `${a}|${t}`;
    const tokens = ["1", "2"];

    for (let step = 0; step < 40; step++) {
      const token = pick(tokens);
      if (step < 4 || rand() < 0.3) {
        // Mint and forward to another agent, as pay_with_claim does.
        const to = pick(AGENTS);
        const payer = pick(AGENTS.filter((a) => a !== to));
        const q = BigInt(100 + Math.floor(rand() * 900));
        tracker.recordMint(token, "ISSUER-B", q.toString());
        tracker.recordTransfer(to, undefined, undefined, { tokenId: token, quantity: q.toString() });
        ledger.apply(
          { agentId: payer, turn: 1, kind: "pay_with_claim", tokenId: token, quantityMilliSiu: q.toString(), counterparty: address(to) } as never,
          resolve,
        );
        held.set(key(to, token), (held.get(key(to, token)) ?? 0n) + q);
      } else {
        const from = pick(AGENTS);
        const have = held.get(key(from, token)) ?? 0n;
        if (have === 0n) continue;
        const to = pick(AGENTS.filter((a) => a !== from));
        const q = 1n + BigInt(Math.floor(rand() * Number(have)));
        tracker.recordTransfer(to, undefined, undefined, { tokenId: token, quantity: q.toString(), from });
        ledger.apply(
          { agentId: from, turn: 1, kind: "transfer_claim", tokenId: token, quantityMilliSiu: q.toString(), counterparty: address(to), settlesRequestId: "qr-1" } as never,
          resolve,
        );
        held.set(key(from, token), have - q);
        held.set(key(to, token), (held.get(key(to, token)) ?? 0n) + q);
      }
    }

    for (const agent of AGENTS) {
      const fromTracker = tracker
        .positions()
        .filter((p) => p.holder === agent)
        .reduce((sum, p) => sum + BigInt(p.quantity), 0n);
      const fromTest = [...held.entries()]
        .filter(([k]) => k.startsWith(`${agent}|`))
        .reduce((sum, [, v]) => sum + v, 0n);
      expect(fromTracker, `${agent}: tracker vs the test's own count`).toBe(fromTest);
      expect(ledger.heldTotal(agent), `${agent}: ledger vs the test's own count`).toBe(fromTest);
    }
  });
});

describe("a transfer of a claim whose mint was never seen", () => {
  // The loop records a mint only when it can name the issuer as one of the roster's agents. A claim
  // whose issuer it cannot resolve is still a claim somebody was just paid with: its recipient must
  // be told, with the figures the transfer itself carries — not with "tokenId undefined".
  it("still tells its recipient what it holds, from the transfer's own figures", () => {
    const t = new RedemptionTracker();
    t.recordTransfer("WORKER-EXTRACT", undefined, "qr-2", { tokenId: "42", quantity: "3967", from: "WORKER-CODE" });
    const text = t.renderForHolder("WORKER-EXTRACT", 0);
    expect(text).toContain("tokenId 42, quantity 3967.");
    expect(text).toContain("It settles your quote qr-2.");
    expect(text).not.toContain("undefined");
  });

  it("has no issuer to tell anything to, and says so rather than naming one", () => {
    const t = new RedemptionTracker();
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "42", quantity: "100" });
    t.recordPresented("WORKER-EXTRACT", "spec", undefined, "42");
    t.recordServed(true, { tokenId: "42", holder: "WORKER-EXTRACT", quantity: "100" });
    expect(t.renderServedForHolder("WORKER-EXTRACT")).toContain("issuer (unknown)");
    expect(t.renderForIssuerAwaitingDelivery("ISSUER-A")).toBe("");
    expect(t.isIssuerOfAny("ISSUER-A")).toBe(false);
  });

  it("is still listed for settlement, with no issuer it can be attributed to", () => {
    const t = new RedemptionTracker();
    t.recordTransfer("WORKER-EXTRACT", undefined, undefined, { tokenId: "42", quantity: "100" });
    expect(t.positions()).toEqual([
      { tokenId: "42", holder: "WORKER-EXTRACT", issuer: undefined, quantity: "100", presented: false },
    ]);
  });
});
