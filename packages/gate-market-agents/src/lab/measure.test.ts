import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import {
  CIRCULATES_LOWER_BOUND,
  assertCountableForLab,
  bootstrapH2,
  bootstrapOverRuns,
  compareArms,
  decide,
  decideH2,
  labDisqualification,
  measureRun,
  pool,
  renderPooled,
  wilson,
  type H2Counts,
  type MeasureReport,
  type RunMeasures,
  type RunCounts,
  type Verdict,
} from "./measure.js";

const SEATS = { "TRADER-1": "ORCHESTRATOR", "TRADER-2": "WORKER-CODE", "TRADER-3": "WORKER-EXTRACT", "TRADER-4": "ISSUER-A" };
type Moment = MeasureReport["paymentMoments"][number];

/** A clean, countable report with no payments; tests add what they exercise. Illustrative print 0.001437. */
function base(over: Partial<MeasureReport> = {}): MeasureReport {
  const uniform = (needsMet: number, fsiu = "2000") =>
    Object.keys(SEATS).map((t) => ({ trader: t, usdcMinor: "2874", fsiuMilliSiu: fsiu, needsMet, resultNano: "5748000" }));
  return {
    runId: "lab-test",
    seed: 1,
    scripted: false,
    params: DEFAULT_PARAMS,
    print: { rateUsdPerSiu: "0.001437" },
    seats: SEATS,
    economy: {
      needs: Object.keys(SEATS).flatMap((t) => [1, 2].map((k) => ({ id: `${t}#${k}`, buyer: t, seller: "TRADER-9", round: k }))),
    },
    sales: [],
    paymentMoments: [],
    capacityEvents: [],
    operatorActions: [],
    snapshots: [{ label: "opening", round: 1, traders: uniform(0) }],
    final: { traders: uniform(0, "1500") },
    measuredBeforeClose: true,
    needsMet: { "TRADER-1": 0, "TRADER-2": 0, "TRADER-3": 0, "TRADER-4": 0 },
    totalRealizedUsd: "0.120000",
    workCostUsd: "0.030000",
    labErrors: [],
    pool: { whole: true, restored: true },
    instrument: { version: LAB_INSTRUMENT_VERSION },
    ...over,
  };
}

const sale = (requestId: string, kind: "trade" | "rawwork", buyer: string, seller: string) => ({ requestId, kind, buyer, seller, delivered: true });
const moment = (agentId: string, tool: string, requestId: string | undefined, heldReceived: string, usd = "0.0017"): Moment => ({
  agentId,
  tool,
  ...(requestId !== undefined ? { requestId } : {}),
  heldReceivedMilliSiu: heldReceived,
  ...(requestId !== undefined ? { quotedUsdMax: usd } : {}),
});

describe("what a run measured", () => {
  // The claim a 0.0017 job quote needs is 1,184 mSIU; a 0.0014 raw-work quote, 975 (at 0.001437).
  const report = (): MeasureReport =>
    base({
      sales: [
        sale("qr-1", "trade", "TRADER-1", "TRADER-2"), // held, received >= due: reuse
        sale("qr-2", "trade", "TRADER-1", "TRADER-3"), // usdc while holding received >= due: an opportunity, declined
        sale("qr-3", "trade", "TRADER-2", "TRADER-3"), // held from the opening: received 0 < due
        sale("qr-4", "rawwork", "TRADER-2", "ISSUER"), // held for raw work, received >= due: reuse
        sale("qr-5", "trade", "TRADER-3", "TRADER-4"), // usdc, nothing received
        sale("qr-6", "trade", "TRADER-4", "TRADER-1"), // a split, paid while holding some received fSIU
      ],
      paymentMoments: [
        moment("ORCHESTRATOR", "transfer_claim", "qr-1", "1184"),
        moment("ORCHESTRATOR", "pay", "qr-2", "5000"),
        moment("WORKER-CODE", "transfer_claim", "qr-3", "0"),
        moment("WORKER-CODE", "transfer_claim", "qr-4", "975", "0.0014"),
        moment("WORKER-EXTRACT", "pay", "qr-5", "0"),
        moment("ISSUER-A", "settle_split_held", "qr-6", "300"),
        moment("WORKER-CODE", "transfer_claim", undefined, "5000"), // names no quote: settles nothing
      ],
      capacityEvents: [
        // The claim part of the split is recorded as the held-claim transfer it is.
        { kind: "transfer_claim", agentId: "ISSUER-A", quantityMilliSiu: "592", settlesRequestId: "qr-6" },
        { kind: "transfer_claim", agentId: "ORCHESTRATOR", quantityMilliSiu: "1184" },
      ],
      needsMet: { "TRADER-1": 2, "TRADER-2": 1, "TRADER-3": 1, "TRADER-4": 1 },
      operatorActions: [
        { kind: "expiry", holder: "TRADER-1", quantityMilliSiu: "816" },
        { kind: "expiry", holder: "ISSUER-B", quantityMilliSiu: "9999" },
      ],
      waits: [
        { agentId: "WORKER-CODE", turn: 3, hadWork: ["a quote it was sent and has not paid"] },
        { agentId: "WORKER-CODE", turn: 9, hadWork: [] },
        { agentId: "ISSUER-A", turn: 4, hadWork: ["a need to buy, a job owed, or raw work to buy"] },
        { agentId: "ISSUER-B", turn: 2, hadWork: [] }, // the issuer service is not a trader
      ],
    });

  const m = measureRun(report());
  const of = (t: string) => m.traders.find((x) => x.trader === t)!;

  it("counts an opportunity wherever the trader held received fSIU enough to pay, in whatever asset it paid, and a reuse only where it did", () => {
    expect(m.opportunities).toBe(3); // qr-1 (held), qr-2 (usdc), qr-4 (held)
    expect(m.reuse).toBe(2); // qr-1 and qr-4
    expect(of("TRADER-1")).toMatchObject({ opportunities: 2, reuse: 1 });
    expect(of("TRADER-2")).toMatchObject({ opportunities: 1, reuse: 1 });
  });

  it("does not count a held payment that the received fSIU could not have covered as reuse, and says the opening funded it", () => {
    expect(of("TRADER-2").heldFundedByOpening).toBe(1); // qr-3
  });

  it("leaves out a transfer that names no quote: it settles nothing, so it buys nothing", () => {
    const routes = Object.values(m.paymentsByRoute).reduce((a, b) => a + b, 0);
    expect(routes).toBe(6);
  });

  it("counts payments by what was bought and by route", () => {
    expect(m.paymentsByRoute).toEqual({ usdc: 2, held: 3, split: 1 });
    expect(of("TRADER-2").jobsBoughtBy).toEqual({ usdc: 0, held: 1, split: 0 });
    expect(of("TRADER-2").rawBoughtBy).toEqual({ usdc: 0, held: 1, split: 0 });
    expect(m.fsiuShareOfPayments).toBe("0.667"); // four of six payments were not wholly in dollars
  });

  it("reports what each trader disposed of: passed on, redeemed for raw work, expired", () => {
    expect(of("TRADER-1").passedOnMilliSiu).toBe("1184");
    expect(of("TRADER-2")).toMatchObject({ passedOnMilliSiu: "1184", redeemedForRawWorkMilliSiu: "975" });
    // The claim part of a split is a held claim passed on, by the quantity the loop recorded.
    expect(of("TRADER-4").passedOnMilliSiu).toBe("592");
    expect(of("TRADER-1").expiredMilliSiu).toBe("816");
    // The issuer's and the operator's leftovers are not a trader's disposal.
    expect(m.traders.map((t) => t.expiredMilliSiu)).toEqual(["816", "0", "0", "0"]);
  });

  it("reports a split that spends received fSIU as partial reuse, apart from reuse, and does not count it as an opportunity it did not meet", () => {
    // qr-6: 300 mSIU received against 1,184 due is not an opportunity, and the split is not a reuse; but 300 of its 592 mSIU
    // claim part came from what the trader had received, so it is partial reuse.
    expect(m.partialReuse).toBe(1);
    expect(of("TRADER-4")).toMatchObject({ partialReuse: 1, partialReuseMilliSiu: "300", opportunities: 0, reuse: 0 });
    expect(m.reuse).toBe(2); // unchanged by it
  });

  it("reports needs met against all needs, and no mints (nothing is minted after the opening)", () => {
    expect(m.needsMet).toBe(5);
    expect(m.needsTotal).toBe(8);
    expect(m.jobsTransacted).toBe(5);
    expect(m).not.toHaveProperty("mints");
  });

  it("counts the waits a trader took with something on its screen, and none of the issuer service's (D34)", () => {
    expect(m.waitedWithWork).toBe(2);
    expect(of("TRADER-2")).toMatchObject({ waits: 2, waitedWithWork: 1 });
    expect(of("TRADER-4")).toMatchObject({ waits: 1, waitedWithWork: 1 });
    expect(m.traders.reduce((s, t) => s + t.waits, 0)).toBe(3);
  });

  it("reads a report made before waits were recorded as having none", () => {
    const old = measureRun(base());
    expect(old.waitedWithWork).toBe(0);
  });

  it("states holdings against what each trader still has to buy, at every snapshot", () => {
    const row = m.holdings.find((h) => h.label === "opening" && h.trader === "TRADER-1")!;
    expect(row).toMatchObject({ fsiuMilliSiu: "2000", unmetNeeds: 2, upcomingNeedsMilliSiu: "2368" }); // 2 jobs x 1,184
    const last = m.holdings.find((h) => h.label === "final" && h.trader === "TRADER-1")!;
    expect(last.fsiuMilliSiu).toBe("1500");
  });

  it("adds inference and graded-work cost as decimals", () => {
    expect(m.costUsd).toBe("0.150000");
  });

  it("reports each result and where the trader started", () => {
    expect(of("TRADER-1")).toMatchObject({ resultNano: "5748000", openingResultNano: "5748000", needsMet: 2 });
  });
});

describe("which runs may be counted", () => {
  it("accepts a clean model run", () => {
    expect(labDisqualification(base())).toBeNull();
    expect(() => assertCountableForLab(base())).not.toThrow();
  });

  const cases: [string, Partial<MeasureReport>, RegExp][] = [
    ["a scripted walk", { scripted: true }, /scripted walk/],
    ["a run stopped by a spending cap", { haltedReason: { ORCHESTRATOR: "experiment_halt", "WORKER-CODE": "max_turns" } }, /stopped by a spending cap, not by its agents \(ORCHESTRATOR: experiment_halt\)/],
    ["a seat stopped by its provider", { haltedReason: { "WORKER-CODE": "adapter_error", ORCHESTRATOR: "nothing_to_act_on" } }, /stopped by its provider or the harness, not by its own choices \(WORKER-CODE: adapter_error\)/],
    ["a seat stopped by the harness's own validator", { haltedReason: { "WORKER-CODE": "validation_failed" } }, /not by its own choices/],
    ["a seat stopped by the run's infrastructure failing", { haltedReason: { "WORKER-CODE": "run_infrastructure_failed" } }, /not by its own choices/],
    ["a run stopped by an agent's own ceiling", { haltedReason: { "WORKER-EXTRACT": "ceiling" } }, /spending cap/],
    ["a run made before versions were stamped", { instrument: undefined }, /before versions were stamped.*current version/],
    ["a run made under an earlier version of the lab", { instrument: { version: LAB_INSTRUMENT_VERSION - 1 } }, new RegExp(`version ${LAB_INSTRUMENT_VERSION - 1}, not the current version ${LAB_INSTRUMENT_VERSION}`)],
    ["an aborted run", { abortedBecause: "the endowment was backed by ISSUER-A" }, /aborted: the endowment/],
    ["a contaminated run", { contamination: "a mint was backed by TRADER-4" }, /contaminated/],
    ["a harness failure", { infrastructureFailure: {} }, /harness failed/],
    ["bookkeeping errors", { labErrors: [{}] }, /bookkeeping/],
    ["a partial pool", { pool: { whole: false, restored: true } }, /not whole/],
    ["a pool left short", { pool: { whole: true, restored: false } }, /not restored/],
    ["no scoring snapshot", { final: undefined }, /no scoring snapshot/],
    ["a snapshot after close", { measuredBeforeClose: false }, /after the window closed/],
  ];
  for (const [what, over, why] of cases) {
    it(`refuses ${what}, by the recomputed reason and through the existing guard`, () => {
      const r = base(over);
      expect(labDisqualification(r)).toMatch(why);
      expect(() => assertCountableForLab(r)).toThrow(why);
    });
  }

  it("does not disqualify a seat that sent a malformed reply or was refused by its model: those are what the agent did", () => {
    expect(labDisqualification(base({ haltedReason: { "ISSUER-A": "parse_error", "WORKER-CODE": "policy_refusal" } }))).toBeNull();
  });

  it("does not disqualify a run in which agents simply used their turns, or stopped on their own", () => {
    const r = base({ haltedReason: { ORCHESTRATOR: "voluntary_stop", "WORKER-CODE": "max_turns", "ISSUER-B": "waiting", "ISSUER-A": "window_span_elapsed" } });
    expect(labDisqualification(r)).toBeNull();
  });

  it("honours a disqualification the runner stamped, even if the facts look clean", () => {
    const r = base({ debugMode: { disqualifiedBecause: "stamped by the runner" } });
    expect(() => assertCountableForLab(r)).toThrow(/stamped by the runner/);
  });
});

describe("the Wilson interval", () => {
  // Reference values for the 95% Wilson score interval.
  it.each([
    [5, 10, 0.2366, 0.7634],
    [0, 10, 0, 0.2775],
    [10, 10, 0.7225, 1],
    [28, 30, 0.7868, 0.9815],
    [0, 30, 0, 0.1135],
  ])("%i of %i gives %f to %f", (k, n, lo, hi) => {
    const i = wilson(k, n);
    expect(i.lower).toBeCloseTo(lo, 3);
    expect(i.upper).toBeCloseTo(hi, 3);
  });

  it("has no interval for no observations, and says so", () => {
    expect(Number.isNaN(wilson(0, 0).lower)).toBe(true);
  });
});

describe("the bootstrap over runs", () => {
  const counts = (spec: [number, number][]): RunCounts[] => spec.map(([opportunities, reuse]) => ({ opportunities, reuse }));
  const repeat = (n: number, c: [number, number]): [number, number][] => Array.from({ length: n }, () => c);

  it("is the same every time it is computed: the seed is fixed and reported", () => {
    const runs = counts([...repeat(12, [10, 10]), ...repeat(8, [10, 0])]);
    expect(bootstrapOverRuns(runs)).toEqual(bootstrapOverRuns(runs));
    expect(bootstrapOverRuns(runs).seed).toBe(20_261_006);
    expect(bootstrapOverRuns(runs, { seed: 1 })).not.toEqual(bootstrapOverRuns(runs));
  });

  it("is a point when every run is alike", () => {
    const b = bootstrapOverRuns(counts(repeat(20, [10, 5])));
    expect(b).toMatchObject({ rate: 0.5, lower: 0.5, upper: 0.5, runs: 20, discarded: 0 });
  });

  it("is wider than the Wilson interval on the same pooled counts when runs differ — the reason runs are resampled", () => {
    // Half the runs reuse everything and half nothing: 100 of 200 pooled, but only 20 independent observations.
    const runs = counts([...repeat(10, [10, 10]), ...repeat(10, [10, 0])]);
    const b = bootstrapOverRuns(runs);
    const w = wilson(100, 200);
    expect(b.rate).toBe(0.5);
    expect(b.lower).toBeLessThan(w.lower - 0.1);
    expect(b.upper).toBeGreaterThan(w.upper + 0.1);
  });

  it("leaves out draws that contain no opportunity, and says how many", () => {
    const b = bootstrapOverRuns(counts([...repeat(19, [0, 0]), [10, 10]]));
    expect(b.discarded).toBeGreaterThan(0);
    expect(b.discarded).toBeLessThan(b.draws);
    expect(b).toMatchObject({ lower: 1, upper: 1 }); // every draw that has an opportunity reused all of them
  });

  it("has no interval when there is no opportunity at all", () => {
    const b = bootstrapOverRuns(counts(repeat(20, [0, 0])));
    expect(Number.isNaN(b.lower)).toBe(true);
    expect(b.discarded).toBe(b.draws);
    expect(Number.isNaN(bootstrapOverRuns([]).upper)).toBe(true);
  });
});

describe("the approved decision rule", () => {
  const counts = (spec: [number, number][]): RunCounts[] => spec.map(([opportunities, reuse]) => ({ opportunities, reuse }));
  const repeat = (n: number, c: [number, number]): [number, number][] => Array.from({ length: n }, () => c);
  const verdictOf = (spec: [number, number][]): Verdict => {
    const runs = counts(spec);
    return decide({
      opportunities: runs.reduce((s, r) => s + r.opportunities, 0),
      runsWithOpportunity: runs.filter((r) => r.opportunities > 0).length,
      interval: bootstrapOverRuns(runs),
    });
  };

  it("is inconclusive below 30 opportunities, whatever the rate", () => {
    expect(verdictOf(repeat(20, [1, 1]))).toBe("inconclusive"); // 20 opportunities, all reused
    expect(verdictOf(repeat(10, [2, 2]))).toBe("inconclusive");
  });

  it("is inconclusive if fewer than 10 runs contribute an opportunity, even when those few are unanimous", () => {
    // 9 runs, 100 opportunities each, all reused: the pooled count is huge and the interval is [1, 1].
    const spec = [...repeat(9, [100, 100] as [number, number]), ...repeat(11, [0, 0] as [number, number])];
    expect(verdictOf(spec)).toBe("inconclusive");
    // The tenth run tips it.
    expect(verdictOf([...repeat(10, [100, 100] as [number, number]), ...repeat(10, [0, 0] as [number, number])])).toBe("circulates");
  });

  it("says fSIU circulates when the run-resampled lower bound reaches 0.50", () => {
    expect(verdictOf(repeat(20, [3, 3]))).toBe("circulates");
  });

  it("says it does not circulate when the run-resampled upper bound is below 0.20", () => {
    expect(verdictOf(repeat(20, [3, 0]))).toBe("does not circulate");
  });

  it("is never 'no effect': the middle is 'no detectable effect at this sample size'", () => {
    const v = verdictOf(repeat(20, [3, 1]));
    expect(v).toBe("no detectable effect at this sample size");
    expect(v).not.toMatch(/^no effect/);
  });

  it("applies the thresholds at their edges, to the interval it is given", () => {
    const base = { opportunities: 30, runsWithOpportunity: 10 };
    expect(decide({ ...base, interval: { lower: 0.5, upper: 0.9 } })).toBe("circulates");
    expect(decide({ ...base, interval: { lower: 0.49, upper: 0.9 } })).toBe("no detectable effect at this sample size");
    expect(decide({ ...base, interval: { lower: 0, upper: 0.1999 } })).toBe("does not circulate");
    expect(decide({ ...base, interval: { lower: 0, upper: 0.2 } })).toBe("no detectable effect at this sample size");
    expect(decide({ opportunities: 29, runsWithOpportunity: 10, interval: { lower: 1, upper: 1 } })).toBe("inconclusive");
    expect(decide({ opportunities: 30, runsWithOpportunity: 9, interval: { lower: 1, upper: 1 } })).toBe("inconclusive");
  });

  it("reads the interval resampled over runs, not the Wilson interval — they can disagree", () => {
    // 12 runs reuse everything and 8 nothing: 120 of 200 pooled. Wilson on 200 decisions clears 0.50; twenty runs do not.
    const spec = [...repeat(12, [10, 10] as [number, number]), ...repeat(8, [10, 0] as [number, number])];
    expect(wilson(120, 200).lower).toBeGreaterThan(CIRCULATES_LOWER_BOUND);
    expect(bootstrapOverRuns(counts(spec)).lower).toBeLessThan(CIRCULATES_LOWER_BOUND);
    expect(verdictOf(spec)).toBe("no detectable effect at this sample size");
  });
});

describe("pooling runs", () => {
  const runWith = (id: string, reused: number, declined: number): MeasureReport => {
    const sales = [] as MeasureReport["sales"];
    const moments = [] as Moment[];
    for (let i = 0; i < reused + declined; i++) {
      const rid = `${id}-${i}`;
      sales.push(sale(rid, "trade", "TRADER-1", "TRADER-2"));
      moments.push(moment("ORCHESTRATOR", i < reused ? "transfer_claim" : "pay", rid, "5000"));
    }
    return base({ runId: id, sales, paymentMoments: moments });
  };
  const twenty = (make: (i: number) => MeasureReport): MeasureReport[] => Array.from({ length: 20 }, (_, i) => make(i));

  it("pools only runs the guard admits, lists the rest with their reason, and applies the rule to the pool", () => {
    const pooled = pool([
      ...twenty((i) => runWith(`r${i}`, 2, 1)),
      { ...runWith("walk", 5, 0), scripted: true },
      { ...runWith("bad", 5, 0), abortedBecause: "boom" },
    ]);
    expect(pooled.runsAdmitted).toBe(20);
    expect(pooled.runsExcluded.map((e) => e.runId)).toEqual(["walk", "bad"]);
    expect(pooled.runsExcluded[0].because).toMatch(/scripted walk/);
    expect(pooled).toMatchObject({ opportunities: 60, reuse: 40, runsWithOpportunity: 20 });
    expect(pooled.interval.rate).toBeCloseTo(40 / 60, 10);
    expect(pooled.verdict).toBe("circulates"); // every run reuses two of three: the resampled lower bound is 2/3
  });

  it("reports the Wilson interval beside the run-resampled one, and they are not the same", () => {
    const pooled = pool(twenty((i) => (i < 12 ? runWith(`r${i}`, 10, 0) : runWith(`r${i}`, 0, 10))));
    expect(pooled.wilson.lower).toBeGreaterThan(CIRCULATES_LOWER_BOUND); // 120 of 200
    expect(pooled.interval.lower).toBeLessThan(CIRCULATES_LOWER_BOUND);
    expect(pooled.verdict).toBe("no detectable effect at this sample size");
  });

  it("counts a run as reusing a majority only when more than half of its opportunities were reused", () => {
    const pooled = pool([runWith("half", 5, 5), runWith("most", 6, 4)]);
    expect(pooled.runsWithMajorityReused).toBe(1);
  });

  it("is inconclusive on too few runs even when every opportunity was reused", () => {
    const pooled = pool(twenty((i) => (i < 9 ? runWith(`r${i}`, 10, 0) : runWith(`r${i}`, 0, 0))));
    expect(pooled.opportunities).toBe(90);
    expect(pooled.runsWithOpportunity).toBe(9);
    expect(pooled.verdict).toBe("inconclusive");
  });

  it("renders both intervals, the guard, the verdict in capitals, and every exclusion by name", () => {
    const text = renderPooled(pool([runWith("a", 10, 0), { ...runWith("walk", 1, 0), scripted: true }]));
    expect(text).toContain("excluded walk:");
    expect(text).toContain("interval the rule reads — 95% bootstrap over runs");
    expect(text).toContain("beside it, not read — pooled Wilson");
    expect(text).toContain("runs with an opportunity 1 of 1 (the rule needs 10)");
    expect(text).toContain("verdict under the approved rule: INCONCLUSIVE");
  });
});

describe("comparing two arms", () => {
  it("calls it an effect only when the intervals do not overlap", () => {
    expect(compareArms({ lower: 0.7, upper: 0.9 }, { lower: 0.1, upper: 0.3 })).toBe("effect");
    expect(compareArms({ lower: 0.4, upper: 0.8 }, { lower: 0.2, upper: 0.5 })).toBe("no detectable effect at this sample size");
    expect(compareArms({ lower: Number.NaN, upper: Number.NaN }, { lower: 0.2, upper: 0.5 })).toBe("no detectable effect at this sample size");
  });
});

describe("what was paid to the issuer for raw work", () => {
  // D8, D23: a claim paid to the issuer is a redemption in effect, whichever way it was paid.
  const raw = (id: string, buyer: string) => sale(id, "rawwork", buyer, "ISSUER");
  const r = base({
    sales: [raw("qr-1", "TRADER-1"), raw("qr-2", "TRADER-3"), raw("qr-3", "TRADER-4")],
    paymentMoments: [
      moment("ORCHESTRATOR", "transfer_claim", "qr-1", "0", "0.0014"), // a held claim
      moment("WORKER-EXTRACT", "settle_split_held", "qr-2", "0", "0.0014"), // the claim part of a split
      moment("ISSUER-A", "pay", "qr-3", "0", "0.0014"), // dollars: no claim reaches the issuer
    ],
    capacityEvents: [
      { kind: "transfer_claim", agentId: "ORCHESTRATOR", quantityMilliSiu: "975", settlesRequestId: "qr-1" },
      { kind: "transfer_claim", agentId: "WORKER-EXTRACT", quantityMilliSiu: "487", settlesRequestId: "qr-2" },
    ],
    operatorActions: [{ kind: "expiry", holder: "ISSUER-B", quantityMilliSiu: "1462" }],
  });
  const m = measureRun(r);
  const of = (t: string) => m.traders.find((x) => x.trader === t)!;

  it("counts every claim paid to the issuer as redeemed for raw work", () => {
    expect(of("TRADER-1")).toMatchObject({ redeemedForRawWorkMilliSiu: "975" });
    expect(of("TRADER-3")).toMatchObject({ redeemedForRawWorkMilliSiu: "487" }); // the quantity the loop recorded
    expect(of("TRADER-4")).toMatchObject({ redeemedForRawWorkMilliSiu: "0" }); // paid in dollars
  });

  it("reports what the issuer was left holding at the close — it can pass none of it on", () => {
    expect(m.leftWithIssuerMilliSiu).toBe("1462");
  });
});

describe("an opportunity is judged at the print of the quote's round (D41)", () => {
  // At round 3's print of 1,900,432 a job quote is $0.0023 and its claim 1,211 mSIU; at round 1's 1,437,000 the same $0.0023 would take 1,601.
  const report = (heldReceived: string): MeasureReport =>
    base({
      prints: { byRound: ["1437000", "1652550", "1900432"], stepBps: 1500 },
      sales: [{ requestId: "qr-1", round: 3, kind: "trade", buyer: "TRADER-1", seller: "TRADER-2", delivered: true }],
      paymentMoments: [moment("ORCHESTRATOR", "transfer_claim", "qr-1", heldReceived, "0.0023")],
    });

  it("counts holding enough received fSIU for the quote at its own round's print as an opportunity", () => {
    const m = measureRun(report("1211"));
    expect(m.opportunities).toBe(1);
    expect(m.reuse).toBe(1);
  });

  it("does not count holding less than that, even if it would have covered the quote at another round's print", () => {
    expect(measureRun(report("1210")).opportunities).toBe(0);
  });

  it("falls back to the report's one print for a report that has none, as every earlier run did", () => {
    const m = measureRun(base({ sales: [sale("qr-1", "trade", "TRADER-1", "TRADER-2")], paymentMoments: [moment("ORCHESTRATOR", "transfer_claim", "qr-1", "1184")] }));
    expect(m.opportunities).toBe(1);
  });
});

describe("H2 — fSIU held at each round's start against the raw work still to buy (D41)", () => {
  const needs = [
    { id: "a", buyer: "TRADER-2", seller: "TRADER-1", round: 1 },
    { id: "b", buyer: "TRADER-3", seller: "TRADER-1", round: 3 },
    { id: "c", buyer: "TRADER-1", seller: "TRADER-2", round: 1 },
    { id: "d", buyer: "TRADER-4", seller: "TRADER-2", round: 2 },
    { id: "e", buyer: "TRADER-1", seller: "TRADER-3", round: 2 },
    { id: "f", buyer: "TRADER-2", seller: "TRADER-4", round: 1 },
  ];
  // fSIU each trader holds when each round opens: TRADER-4 spends down; the rest keep most of it.
  const held: Record<string, string[]> = {
    "TRADER-1": ["4516", "4516", "4516"],
    "TRADER-2": ["4516", "4516", "3000"],
    "TRADER-3": ["4516", "4516", "2258"],
    "TRADER-4": ["4516", "2258", "0"],
  };
  const snapshot = (round: number, label: string) => ({
    label,
    round,
    traders: ["TRADER-1", "TRADER-2", "TRADER-3", "TRADER-4"].map((t) => ({ trader: t, usdcMinor: "8583", fsiuMilliSiu: held[t][round - 1], needsMet: 0, resultNano: "0" })),
  });
  const run = (): RunMeasures =>
    measureRun(
      base({
        prints: { byRound: ["1437000", "1652550", "1900432"], stepBps: 1500 },
        opening: { fsiuMilliSiuPerTrader: "4516" },
        economy: { needs },
        snapshots: [snapshot(1, "opening"), snapshot(2, "round 2 opened"), snapshot(3, "round 3 opened")],
        final: { traders: snapshot(3, "final").traders },
      }),
    );

  it("counts, for each trader at each round's start, the units of raw work its schedule still has it buying: jobs it sells in that round or later", () => {
    const rows = run().holdings.filter((h) => h.label !== "final");
    const units = (t: string, r: number) => rows.find((h) => h.trader === t && h.round === r)!.upcomingRawUnits;
    expect([1, 2, 3].map((r) => units("TRADER-1", r))).toEqual([2, 1, 1]); // sells in rounds 1 and 3
    expect([1, 2, 3].map((r) => units("TRADER-2", r))).toEqual([2, 1, 0]); // rounds 1 and 2
    expect([1, 2, 3].map((r) => units("TRADER-3", r))).toEqual([1, 1, 0]); // round 2
    expect([1, 2, 3].map((r) => units("TRADER-4", r))).toEqual([1, 0, 0]); // round 1
  });

  it("states those units in mSIU at that round's print: about 1 SIU each whatever the print", () => {
    const row = run().holdings.find((h) => h.trader === "TRADER-1" && h.round === 3 && h.label !== "final")!;
    expect(row.upcomingRawWorkMilliSiu).toBe("1000"); // $0.0019 at 1,900,432 nano-USD per SIU
    const first = run().holdings.find((h) => h.trader === "TRADER-1" && h.round === 1)!;
    expect(first.upcomingRawWorkMilliSiu).toBe("1950"); // two units at 975 mSIU at round 1's print
  });

  it("measures a holding as a fraction of what the trader opened with, and never the final row", () => {
    const m = run();
    const row = (t: string, r: number) => m.holdings.find((h) => h.trader === t && h.round === r && h.label !== "final")!;
    expect(row("TRADER-4", 2).heldFraction).toBe(0.5);
    expect(row("TRADER-3", 3).heldFraction).toBe(0.5);
    expect(m.holdings.find((h) => h.label === "final")!.heldFraction).toBeUndefined();
    expect(m.h2.rows).toHaveLength(12);
  });

  it("splits the trader-rounds into those with raw work still to buy and those without, and sums their holdings", () => {
    const { counts } = run().h2;
    // with: round 1 all four; round 2 TRADER-1, -2, -3; round 3 TRADER-1.  without: TRADER-4 in round 2; TRADER-2, -3, -4 in round 3.
    expect(counts.withN).toBe(8);
    expect(counts.withoutN).toBe(4);
    expect(counts.withSum).toBeCloseTo(1 + 1 + 1 + 1 + 1 + 1 + 1 + 1, 6);
    // A holding is recorded as a fraction to four decimals: 3,000 / 4,516 is 0.6643.
    expect(counts.withoutSum).toBeCloseTo(0.5 + 0.6643 + 0.5 + 0, 9);
  });

  describe("the interval and the proposed rule", () => {
    const runs = (n: number, withMean: number, withoutMean: number): H2Counts[] =>
      Array.from({ length: n }, () => ({ withN: 8, withSum: 8 * withMean, withoutN: 4, withoutSum: 4 * withoutMean }));

    it("is the difference of the two means, with an interval from resampling runs", () => {
      const i = bootstrapH2(runs(20, 1, 0.5));
      expect(i.delta).toBeCloseTo(0.5, 9);
      expect(i.lower).toBeCloseTo(0.5, 9); // identical runs: nothing to resample
      expect(i.upper).toBeCloseTo(0.5, 9);
    });

    it("widens when runs differ, and is the same every time (fixed seed)", () => {
      const mixed = [...runs(10, 1, 0.9), ...runs(10, 1, 0.3)];
      const a = bootstrapH2(mixed);
      expect(bootstrapH2(mixed)).toEqual(a);
      expect(a.lower).toBeLessThan(a.delta);
      expect(a.upper).toBeGreaterThan(a.delta);
    });

    it("has no interval when a group is empty", () => {
      const i = bootstrapH2([{ withN: 8, withSum: 8, withoutN: 0, withoutSum: 0 }]);
      expect(Number.isNaN(i.delta)).toBe(true);
      expect(bootstrapH2([]).runs).toBe(0);
    });

    it("is inconclusive below 30 trader-rounds without raw work to buy, or below 10 runs contributing both groups", () => {
      const good = { delta: 0.5, lower: 0.4, upper: 0.6 };
      expect(decideH2({ traderRoundsWithout: 29, runsWithBoth: 20, interval: good })).toBe("inconclusive");
      expect(decideH2({ traderRoundsWithout: 80, runsWithBoth: 9, interval: good })).toBe("inconclusive");
      expect(decideH2({ traderRoundsWithout: 30, runsWithBoth: 10, interval: good })).toBe("supported");
    });

    it("is supported only with the lower bound at 0.10 or more and a difference of at least 0.20", () => {
      const at = (delta: number, lower: number, upper: number) => decideH2({ traderRoundsWithout: 80, runsWithBoth: 20, interval: { delta, lower, upper } });
      expect(at(0.3, 0.1, 0.5)).toBe("supported");
      expect(at(0.3, 0.09, 0.5)).toBe("no detectable effect at this sample size");
      expect(at(0.15, 0.1, 0.2)).toBe("no detectable effect at this sample size"); // lower bound met, but the difference is under 0.20
    });

    it("is not supported when the whole interval sits below 0.10", () => {
      expect(decideH2({ traderRoundsWithout: 80, runsWithBoth: 20, interval: { delta: 0.02, lower: -0.05, upper: 0.09 } })).toBe("not supported");
      expect(decideH2({ traderRoundsWithout: 80, runsWithBoth: 20, interval: { delta: 0.05, lower: -0.05, upper: 0.1 } })).toBe("no detectable effect at this sample size");
    });

    it("pools runs, reads the rule, and puts the result beside H1's in the rendered report", () => {
      const reports = Array.from({ length: 2 }, (_, k) =>
        base({
          runId: `lab-h2-${k}`,
          prints: { byRound: ["1437000", "1652550", "1900432"], stepBps: 1500 },
          opening: { fsiuMilliSiuPerTrader: "4516" },
          economy: { needs },
          snapshots: [snapshot(1, "opening"), snapshot(2, "round 2 opened"), snapshot(3, "round 3 opened")],
          final: { traders: snapshot(3, "final").traders },
        }),
      );
      const pooled = pool(reports);
      expect(pooled.h2.traderRoundsWith).toBe(16);
      expect(pooled.h2.traderRoundsWithout).toBe(8);
      expect(pooled.h2.runsWithBoth).toBe(2);
      expect(pooled.h2.verdict).toBe("inconclusive"); // 8 trader-rounds without, 2 runs
      const text = renderPooled(pooled);
      expect(text).toContain("H2 (fSIU held at each round's start");
      expect(text).toContain("verdict under the proposed rule: INCONCLUSIVE");
      expect(text).toContain("verdict under the approved rule"); // H1's line is still there
    });
  });
});
