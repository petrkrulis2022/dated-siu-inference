import { describe, expect, it } from "vitest";
import { buildBlockReport, BLOCK_CAPTION, renderBlockReport, type ReportEvent, type ReportMoment, type ReportWindow, type RunReport } from "./block-report.js";
import type { Opportunity } from "./decision-rule.js";
import { sellerFeeAsymmetry } from "./instrument-report.js";

const B = "0xB000000000000000000000000000000000000001";
const A = "0xA000000000000000000000000000000000000001";

type Asset = "usdc" | "fsiu" | "split";

interface WindowSpec {
  windowIndex: number;
  decisions?: { buyer: string; asset: Asset }[];
  moments?: Partial<ReportMoment>[];
  events?: ReportEvent[];
  journeys?: { hops: number; turnsHeld: number }[];
  turns?: Record<string, number>;
  settlements?: { requestId: string; settledMinorUnits: string; quotedMinorUnits: string }[];
  gateDelivered?: boolean;
  passed?: boolean;
  incompleteBecause?: string;
}

const window = (w: WindowSpec): ReportWindow => ({
  windowIndex: w.windowIndex,
  passed: w.passed ?? true,
  gateDelivered: w.gateDelivered ?? true,
  ...(w.incompleteBecause ? { incompleteBecause: w.incompleteBecause } : {}),
  purchases: {
    decisions: (w.decisions ?? []).map((d, i) => ({ ...d, turn: i + 1 })),
    journeys: (w.journeys ?? []).map((j, i) => ({ tokenId: `t${w.windowIndex}-${i}`, outcome: "redeemed", ...j })),
  },
  paymentMoments: (w.moments ?? []).map((m, i) => ({
    agentId: "ORCHESTRATOR",
    turn: i + 1,
    tool: "pay",
    asset: "usdc" as const,
    heldReceivedMilliSiu: "0",
    ...m,
  })),
  usdcSettlements: w.settlements ?? [],
  capacityEvents: w.events ?? [],
  turnsByAgent: w.turns ?? {},
});

const run = (runId: string, windows: WindowSpec[], extra: Partial<RunReport> = {}): RunReport => ({
  runId,
  instrument: { id: "single-issuer" },
  rateUsdPerSiu: "0.0100",
  f1: {
    window: 1,
    reached: true,
    clean: { expectedIssuer: B, clean: true, mints: 1, backedByOthers: 0 },
    opportunities: {},
    countingErrors: [],
  },
  windows: windows.map(window),
  ...extra,
});

const w1 = (over: Partial<WindowSpec> = {}): WindowSpec => ({ windowIndex: 1, ...over });

describe("buildBlockReport — what counts", () => {
  it("excludes a debug run, an aborted run and a report that predates the f1 block, each with its reason", () => {
    const r = buildBlockReport([
      run("good", [w1()]),
      run("debug", [w1()], { debugMode: { disqualifiedBecause: "pinned gate" } }),
      run("aborted", [w1()], { abortedBecause: "router routed to the wrong issuer" }),
      { ...run("old", [w1()]), f1: undefined },
    ]);
    expect(r.runs.map((x) => x.runId)).toEqual(["good"]);
    expect(Object.fromEntries(r.excluded.map((e) => [e.runId, e.because]))).toMatchObject({
      debug: expect.stringMatching(/pinned gate/),
      aborted: expect.stringMatching(/router routed to the wrong issuer/),
      old: expect.stringMatching(/predates the f1 block/),
    });
  });

  it("excludes a run the harness failed, as that and not as anything the agents did — even with a full f1 block", () => {
    const r = buildBlockReport([
      run("good", [w1()]),
      run("harness", [w1()], {
        infrastructureFailure: {
          agentId: "WORKER-CODE",
          windowIndex: 1,
          turn: 4,
          attempts: 2,
          detail: "agent WORKER-CODE, turn 4: two consecutive completions ended at the token budget with no text",
        },
      }),
    ]);
    expect(r.runs.map((x) => x.runId)).toEqual(["good"]);
    expect(r.excluded).toEqual([
      {
        runId: "harness",
        because: expect.stringMatching(/^infrastructure failure in window 1:.*token budget/),
      },
    ]);
  });

  it("refuses to pool runs from different instruments", () => {
    expect(() =>
      buildBlockReport([run("a", [w1()]), run("b", [w1()], { instrument: { id: "fifth-trio-two-issuer" } })]),
    ).toThrow(/cannot be pooled/);
  });

  it("does not let an excluded run on another instrument make the block unpoolable", () => {
    const r = buildBlockReport([
      run("good", [w1()]),
      run("debug", [w1()], { instrument: { id: "other" }, debugMode: { disqualifiedBecause: "debug" } }),
    ]);
    expect(r.instrument).toBe("single-issuer");
  });

  it("carries the fixed caption: scoped to window 1, and honest that the issuers are Touchstone's own", () => {
    expect(BLOCK_CAPTION).toMatch(/^Single issuer per window\. In window 1, where F1 is measured/);
    expect(BLOCK_CAPTION).toContain("Windows 2 and 3 exercise enforcement against an issuer that cannot serve");
    expect(BLOCK_CAPTION).toContain("All issuers are Touchstone's own API accounts");
    expect(BLOCK_CAPTION).toContain("lot sizes are scenario parameters, not measured issuance");
    expect(BLOCK_CAPTION).toMatch(/Cross-issuer fungibility and routing are not tested\.$/);
    expect(BLOCK_CAPTION).not.toMatch(/always redeemable/i);
    expect(buildBlockReport([]).caption).toBe(BLOCK_CAPTION);
  });
});

describe("buildBlockReport — F1 is window 1 alone", () => {
  it("counts per-buyer decisions from window 1 only; window 2's fSIU purchase is not preference", () => {
    const r = buildBlockReport([
      run("r1", [
        w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "usdc" }, { buyer: "WORKER-CODE", asset: "fsiu" }] }),
        { windowIndex: 2, decisions: [{ buyer: "ORCHESTRATOR", asset: "fsiu" }, { buyer: "WORKER-CODE", asset: "fsiu" }] },
      ]),
    ]);
    expect(r.f1.perBuyer.ORCHESTRATOR.decisions).toEqual({ usdc: 1, fsiu: 0, split: 0, total: 1 });
    expect(r.f1.perBuyer["WORKER-CODE"].decisions).toEqual({ usdc: 0, fsiu: 1, split: 0, total: 1 });
    // …and it is still reported, separately, as what happened against an issuer that cannot serve.
    expect(r.runs[0].windows.find((w) => w.windowIndex === 2)?.decisions.fsiu).toBe(2);
  });

  // How a buyer paid, by route. Payment moments are recorded for every settling tool.
  const pm = (buyer: string, tool: string, over: Partial<ReportMoment> = {}): Partial<ReportMoment> => ({
    agentId: buyer,
    tool,
    asset: tool === "pay" ? "usdc" : tool === "settle_split" ? "split" : "fsiu",
    requestId: "qr-1",
    heldReceivedMilliSiu: "0",
    ...over,
  });

  it("reports a split as its own count, in neither the held-balance nor the mint-and-forward route", () => {
    const r = buildBlockReport([run("r1", [w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "split" }], moments: [pm("ORCHESTRATOR", "settle_split")] })])]);
    expect(r.f1.perBuyer.ORCHESTRATOR.decisions).toEqual({ usdc: 0, fsiu: 0, split: 1, total: 1 });
    expect(r.runs[0].buyers.ORCHESTRATOR.routes).toMatchObject({ split: 1, heldBalance: 0, mintAndForward: 0, total: 1 });
    expect(r.runs[0].buyers.ORCHESTRATOR.heldBalanceShareBp).toBe(0);
  });

  it("makes paying from a held balance THE headline, with mint-and-forward and USDC beside it, not in it", () => {
    // Mint-and-forward is USDC out of the payer and a new claim into the seller: not the payer
    // spending fSIU it holds. Counting it as "paid in fSIU" would make F1 measure the delivery
    // format. Two of these four payments mint-and-forward, one is USDC, one is from a balance.
    const r = buildBlockReport([
      run("r1", [
        w1({
          moments: [
            pm("ORCHESTRATOR", "pay_with_claim", { requestId: "qr-1" }),
            pm("ORCHESTRATOR", "pay_with_claim", { requestId: "qr-2" }),
            pm("ORCHESTRATOR", "pay", { requestId: "qr-3" }),
            pm("ORCHESTRATOR", "transfer_claim", { requestId: "qr-4" }),
          ],
        }),
      ]),
    ]);
    const b = r.runs[0].buyers.ORCHESTRATOR;
    expect(b.routes).toMatchObject({ heldBalance: 1, mintAndForward: 2, usdc: 1, split: 0, total: 4 });
    expect(b.heldBalanceShareBp).toBe(2500); // the headline: 1 of 4
    expect(b.fsiuAnyRouteShareBp).toBe(7500); // beside it, never instead of it
  });

  it("does not count a transfer that named no quote as a payment at all", () => {
    const r = buildBlockReport([
      run("r1", [
        w1({
          moments: [pm("WORKER-CODE", "transfer_claim", { requestId: undefined }), pm("WORKER-CODE", "pay")],
          events: [{ kind: "transfer_claim", agentId: "WORKER-CODE", turn: 1 }],
        }),
      ]),
    ]);
    expect(r.runs[0].buyers["WORKER-CODE"].routes).toMatchObject({ heldBalance: 0, usdc: 1, total: 1 });
  });

  it("says how many held-balance payments were made while holding fSIU received from another agent", () => {
    // The rest were paid from claims the payer minted for itself first — mint-and-forward in two
    // steps — and a reader should be able to tell the two apart.
    const r = buildBlockReport([
      run("r1", [
        w1({
          moments: [
            pm("WORKER-CODE", "transfer_claim", { requestId: "qr-1", heldReceivedMilliSiu: "5000" }),
            pm("WORKER-CODE", "transfer_claim", { requestId: "qr-2", heldReceivedMilliSiu: "0" }),
          ],
        }),
      ]),
    ]);
    expect(r.runs[0].buyers["WORKER-CODE"].routes).toMatchObject({ heldBalance: 2, heldBalanceWhileHoldingReceived: 1 });
  });

  it("states dispersion of the headline across runs, in basis points rounded down", () => {
    const mk = (id: string, tools: string[]) =>
      run(id, [w1({ moments: tools.map((t, i) => pm("ORCHESTRATOR", t, { requestId: `qr-${i}` })) })]);
    const r = buildBlockReport([mk("a", ["pay"]), mk("b", ["transfer_claim"]), mk("c", ["transfer_claim", "pay", "pay"])]);
    expect(r.f1.perBuyer.ORCHESTRATOR.heldBalanceShareDispersionBp).toEqual({ n: 3, min: 0, median: "3333", max: 10000 });
    expect(r.f1.perBuyer.ORCHESTRATOR.routes).toMatchObject({ heldBalance: 2, usdc: 3, total: 5 });
  });

  it("aggregates cleanliness and names the runs that were not clean", () => {
    const dirty = run("dirty", [w1()]);
    dirty.f1 = { window: 1, reached: true, clean: { expectedIssuer: B, clean: false, mints: 3, backedByOthers: 1 }, opportunities: {}, countingErrors: [] };
    const r = buildBlockReport([run("clean", [w1()]), dirty]);
    expect(r.f1.cleanRuns).toBe(1);
    expect(r.f1.uncleanRuns).toEqual(["dirty"]);
  });

  it("records why window 1 did not pass, by reason", () => {
    const r = buildBlockReport([
      run("a", [w1({ passed: false, incompleteBecause: "testing_never_purchased" })]),
      run("b", [w1({ passed: false, incompleteBecause: "testing_never_purchased" })]),
      run("c", [w1()]),
    ]);
    expect(r.f1.windowOne).toEqual({ passed: 1, incompleteBecause: { testing_never_purchased: 2 } });
  });
});

describe("buildBlockReport — turns per payment", () => {
  it("groups a buyer's window-1 turns by the asset it settled in", () => {
    const r = buildBlockReport([
      run("a", [w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "usdc" }], turns: { ORCHESTRATOR: 3 } })]),
      run("b", [w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "usdc" }], turns: { ORCHESTRATOR: 2 } })]),
      run("c", [w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "fsiu" }], turns: { ORCHESTRATOR: 2 } })]),
    ]);
    const t = r.f1.perBuyer.ORCHESTRATOR.turnsPerPayment;
    expect(t.usdc).toEqual({ n: 2, mean: "2.50", samples: [3, 2] });
    expect(t.fsiu).toEqual({ n: 1, mean: "2.00", samples: [2] });
    expect(t.split.mean).toBeNull();
  });

  it("files a buyer that settled in two assets under 'mixed' rather than choosing one", () => {
    const r = buildBlockReport([
      run("a", [w1({ decisions: [{ buyer: "ORCHESTRATOR", asset: "usdc" }, { buyer: "ORCHESTRATOR", asset: "fsiu" }], turns: { ORCHESTRATOR: 4 } })]),
    ]);
    expect(r.f1.perBuyer.ORCHESTRATOR.turnsPerPayment.mixed.samples).toEqual([4]);
  });

  it("counts an unkeyed transfer apart: one whose event names no quote settled none", () => {
    // Payment moments cannot tell the two apart — one is recorded for every transfer_claim, keyed or
    // not — so the discriminator is the capacity event's own record of the quote it settled. (An
    // earlier version of this test asserted the opposite and passed against a counter that was
    // always zero: a fixture built from the code's own assumption.)
    const r = buildBlockReport([
      run("a", [
        w1({
          decisions: [{ buyer: "WORKER-CODE", asset: "fsiu" }],
          events: [
            { kind: "transfer_claim", agentId: "WORKER-CODE", turn: 5, settlesRequestId: "qr-1" }, // keyed
            { kind: "transfer_claim", agentId: "WORKER-CODE", turn: 7, settlesRequestId: "qr-2" }, // keyed
            { kind: "transfer_claim", agentId: "WORKER-CODE", turn: 9 }, // names no quote
            { kind: "transfer_claim", agentId: "ORCHESTRATOR", turn: 3 }, // someone else's, not counted
          ],
          moments: [
            { agentId: "WORKER-CODE", tool: "transfer_claim", turn: 5, asset: "fsiu", requestId: "qr-1" },
            { agentId: "WORKER-CODE", tool: "transfer_claim", turn: 9, asset: "fsiu" }, // a moment exists for it too
          ],
        }),
      ]),
    ]);
    expect(r.f1.perBuyer["WORKER-CODE"].unkeyedTransfers).toBe(1);
  });
});

describe("buildBlockReport — circulation", () => {
  it("reports the hop distribution and median over window-1 journeys, not later windows'", () => {
    const r = buildBlockReport([
      run("a", [
        w1({ journeys: [{ hops: 0, turnsHeld: 1 }, { hops: 1, turnsHeld: 2 }] }),
        { windowIndex: 2, journeys: [{ hops: 5, turnsHeld: 9 }] },
      ]),
    ]);
    expect(r.f1.hops).toEqual({ distribution: { "0": 1, "1": 1 }, median: "0.5" });
    expect(r.f1.turnsHeld).toEqual({ n: 2, median: "1.5", min: 1, max: 2 });
  });
});

describe("buildBlockReport — cost per SIU comes from what was settled", () => {
  // The metric's arithmetic is tested in cost-metric.test.ts; this checks that the block report
  // feeds it window 1 of each run, with the run's own print, and surfaces both assets.
  it("prices USDC at the settled amount and fSIU at its mint cost, window 1 only", () => {
    const r = buildBlockReport([
      run("a", [
        w1({
          moments: [
            { agentId: "ORCHESTRATOR", turn: 2, tool: "pay", asset: "usdc", requestId: "qr-1", quotedSiu: "1" },
            { agentId: "WORKER-CODE", turn: 3, tool: "pay_with_claim", asset: "fsiu", requestId: "qr-2", quotedSiu: "1" },
          ],
          settlements: [{ requestId: "qr-1", settledMinorUnits: "6000", quotedMinorUnits: "10000" }],
          events: [{ kind: "pay_with_claim", agentId: "WORKER-CODE", turn: 3, tokenId: "7", quantityMilliSiu: "1000", mintCostMinorUnits: "10000", settlesRequestId: "qr-2" }],
        }),
        // a window-2 payment must not enter an F1 cost
        { windowIndex: 2, moments: [{ agentId: "ORCHESTRATOR", turn: 2, tool: "pay", asset: "usdc", requestId: "qr-9", quotedSiu: "1" }], settlements: [{ requestId: "qr-9", settledMinorUnits: "99999", quotedMinorUnits: "99999" }] },
      ]),
    ]);
    expect(r.f1.cost.usdc).toMatchObject({ payments: 1, usd: "0.006000", usdPerSiu: "0.006000" });
    expect(r.f1.cost.fsiu).toMatchObject({ payments: 1, usd: "0.010000", printEquivalentUsd: "0.010000" });
  });

  it("refuses a report that states no print, rather than guessing the print-equivalent", () => {
    const noPrint = run("a", [w1()]);
    delete noPrint.rateUsdPerSiu;
    expect(() => buildBlockReport([noPrint])).toThrow(/no print rate/);
  });
});

describe("buildBlockReport — enforcement is windows 2 onward", () => {
  const settle = (outcome?: "Defaulted" | "Expired", bond?: string): ReportEvent => ({
    kind: "settle_window_close",
    ...(outcome ? { settlementOutcome: outcome } : {}),
    ...(bond ? { bondPaidMinorUnits: bond } : {}),
  });

  it("counts Defaulted and Expired separately, sums the bond paid, and flags a missing outcome", () => {
    const r = buildBlockReport([
      run("a", [
        w1({ events: [settle("Defaulted", "999")] }), // window 1 — not enforcement
        { windowIndex: 2, events: [settle("Defaulted", "14240"), settle("Expired"), settle(undefined)] },
        { windowIndex: 3, events: [settle("Defaulted", "10")] },
      ]),
    ]);
    const byWindow = Object.fromEntries(r.laterWindows.map((w) => [w.windowIndex, w]));
    expect(r.laterWindows.map((w) => w.windowIndex)).toEqual([2, 3]);
    expect(byWindow[2].settlements).toEqual({ defaulted: 1, expired: 1, outcomeNotRecorded: 1 });
    expect(byWindow[2].bondPaidMinorUnits).toBe("14240");
    expect(byWindow[3].settlements.defaulted).toBe(1);
  });

  it("reports allocation by issuer per window, and counts forward-dated claims", () => {
    const mint = (issuer: string, q: string, fwd?: boolean): ReportEvent => ({ kind: "mint_claim", issuer, quantityMilliSiu: q, ...(fwd ? { forwardDated: true } : {}) });
    const r = buildBlockReport([
      run("a", [w1({ events: [mint(B, "10000"), mint(B, "4000", true)] }), { windowIndex: 2, events: [mint(A, "10000")] }]),
    ]);
    expect(r.runs[0].windows[0].allocationByIssuer).toEqual({ [B]: { mints: 2, milliSiu: "14000" } });
    expect(r.runs[0].windows[1].allocationByIssuer).toEqual({ [A]: { mints: 1, milliSiu: "10000" } });
    expect(r.forwardDated).toBe(1);
  });
});

describe("buildBlockReport — the decision rule", () => {
  const opp = (over: Partial<Opportunity>): Opportunity => ({
    eligible: false,
    spentOnward: false,
    basis: "none",
    paidInFsiuWhileHoldingReceived: false,
    ...over,
  });
  const withOpportunity = (id: string, o: Partial<Opportunity>) => {
    const r = run(id, [w1()]);
    r.f1 = {
      window: 1,
      reached: true,
      clean: { expectedIssuer: B, clean: true, mints: 1, backedByOthers: 0 },
      opportunities: { "WORKER-CODE": opp(o) },
      countingErrors: [],
    };
    return r;
  };
  const yes = { eligible: true, spentOnward: true, basis: "held_claim_left_the_balance" as const, paidInFsiuWhileHoldingReceived: true };
  const declined = { eligible: true };

  it("is inconclusive, not negative, when fewer than three runs offered the opportunity", () => {
    const r = buildBlockReport([withOpportunity("a", yes), withOpportunity("b", declined), withOpportunity("c", {})]);
    expect(r.decisionRule.verdict).toBe("inconclusive");
  });

  it("builds on a majority of eligible runs, counting only eligible ones", () => {
    const r = buildBlockReport([
      withOpportunity("a", yes), withOpportunity("b", yes), withOpportunity("c", declined), withOpportunity("d", {}), withOpportunity("e", {}),
    ]);
    expect(r.decisionRule).toMatchObject({ verdict: "build_cross_issuer_fungibility", eligible: 3, spentOnward: 2, runs: 5 });
  });

  it("reports the looser reading beside the balance-level one, and says when they differ", () => {
    // Three eligible runs that only ever paid in fSIU by minting a new claim and forwarding it while
    // holding received fSIU: the balance-level rule sees no onward spending; the looser one sees
    // all three. Reporting both is what keeps a verdict from resting on the shortest fSIU route.
    const mintOnly = { eligible: true, spentOnward: false, paidInFsiuWhileHoldingReceived: true };
    const r = buildBlockReport([withOpportunity("a", mintOnly), withOpportunity("b", mintOnly), withOpportunity("c", mintOnly)]);
    expect(r.decisionRule.verdict).toBe("do_not_build");
    expect(r.decisionRule.looserReading.verdict).toBe("build_cross_issuer_fungibility");
    const text = renderBlockReport(r).join("\n");
    expect(text).toMatch(/Looser reading .*: build_cross_issuer_fungibility/);
    expect(text).toMatch(/DIFFERS from the balance-level verdict/);
  });

  it("refuses to compute any verdict from a run whose eligibility count is wrong", () => {
    const bad = withOpportunity("bad", yes);
    bad.f1 = { ...(bad.f1 as NonNullable<RunReport["f1"]>), countingErrors: ["ORCHESTRATOR is marked eligible, but nothing in this roster pays ORCHESTRATOR in fSIU"] };
    expect(() => buildBlockReport([withOpportunity("a", yes), bad])).toThrow(/bad: counting error — ORCHESTRATOR is marked eligible/);
  });

  it("excludes an f1 block that predates the counting check, with its reason", () => {
    const old = withOpportunity("old", yes);
    old.f1 = { ...(old.f1 as NonNullable<RunReport["f1"]>), countingErrors: undefined as unknown as string[] };
    const r = buildBlockReport([old]);
    expect(r.excluded[0].because).toMatch(/predates the counting check/);
  });

  it("states plainly how it read 'held' and 'spent onward'", () => {
    const a = buildBlockReport([]).decisionRule.assumption;
    expect(a).toMatch(/received as payment from another agent, never an opening balance or operator grant/);
    expect(a).toMatch(/balance level/);
  });
});

describe("buildBlockReport — the seller-side fee asymmetry is recorded either way", () => {
  it("carries the asymmetry the runs recorded, and prints it", () => {
    const fee = sellerFeeAsymmetry(50);
    const r = buildBlockReport([run("a", [w1()], { sellerFeeAsymmetry: fee }), run("b", [w1()], { sellerFeeAsymmetry: fee })]);
    expect(r.sellerFeeAsymmetry).toEqual(fee);
    const out = renderBlockReport(r).join("\n");
    expect(out).toMatch(/seller-side fee: the dollar route charges the seller 50 bps; the fSIU route charges 0/);
    expect(out).toMatch(/not a buyer's cost/i);
  });

  it("says plainly when no run recorded it — a gap is not a zero", () => {
    const r = buildBlockReport([run("a", [w1()])]);
    expect(r.sellerFeeAsymmetry).toBe("not recorded");
    expect(renderBlockReport(r).join("\n")).toMatch(/seller-side fee: NOT recorded/);
  });

  it("says so when the runs disagree, instead of picking one", () => {
    const r = buildBlockReport([
      run("a", [w1()], { sellerFeeAsymmetry: sellerFeeAsymmetry(50) }),
      run("b", [w1()], { sellerFeeAsymmetry: sellerFeeAsymmetry(0) }),
    ]);
    expect(r.sellerFeeAsymmetry).toBe("mixed across runs");
  });
});

describe("renderBlockReport — nothing a reader could miss is left out", () => {
  const text = (reports: RunReport[]) => renderBlockReport(buildBlockReport(reports)).join("\n");

  it("states the caption, every exclusion with its reason, and the verdict beside the reasoning that bounds it", () => {
    const out = text([
      run("good", [w1()]),
      run("dbg", [w1()], { debugMode: { disqualifiedBecause: "pinned gate" } }),
    ]);
    expect(out).toContain(BLOCK_CAPTION);
    expect(out).toMatch(/EXCLUDED dbg: debug run: pinned gate/);
    expect(out).toMatch(/DECISION RULE: inconclusive/);
    expect(out).toMatch(/INCONCLUSIVE, not negative/);
  });

  it("leads each buyer with the headline — paid from a held fSIU balance — and puts the other routes beside it", () => {
    const out = text([run("good", [w1({ moments: [{ agentId: "WORKER-CODE", tool: "pay_with_claim", asset: "fsiu", requestId: "qr-1", heldReceivedMilliSiu: "0" }] })])]);
    expect(out).toMatch(/WORKER-CODE: HEADLINE — paid from a held fSIU balance: 0 of 1 payments/);
    expect(out).toMatch(/beside it: 1 mint-and-forward \(USDC out, a new claim to the seller\)/);
  });

  it("says cost is from what was SETTLED, flags claims it could not match, and that wall-clock holding time is not recorded", () => {
    const out = text([run("good", [w1()])]);
    expect(out).toMatch(/from what was SETTLED/);
    expect(out).toMatch(/UNMATCHED .*not priced as free/);
    expect(out).toMatch(/wall-clock is not recorded/);
  });

  it("flags settlements whose outcome was not recorded, so a gap cannot read as zero enforcements", () => {
    const out = text([run("a", [w1(), { windowIndex: 2, events: [{ kind: "settle_window_close" }] }])]);
    expect(out).toMatch(/1 outcome NOT recorded/);
  });
});
