import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import {
  CIRCULATES_LOWER_BOUND,
  assertCountableForLab,
  bootstrapOverRuns,
  compareArms,
  decide,
  labDisqualification,
  measureRun,
  pool,
  renderPooled,
  wilson,
  type MeasureReport,
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
        sale("qr-5", "trade", "TRADER-3", "TRADER-4"), // mint-and-forward
        sale("qr-6", "trade", "TRADER-4", "TRADER-1"), // split
      ],
      paymentMoments: [
        moment("ORCHESTRATOR", "transfer_claim", "qr-1", "1184"),
        moment("ORCHESTRATOR", "pay", "qr-2", "5000"),
        moment("WORKER-CODE", "transfer_claim", "qr-3", "0"),
        moment("WORKER-CODE", "transfer_claim", "qr-4", "975", "0.0014"),
        moment("WORKER-EXTRACT", "pay_with_claim", "qr-5", "0"),
        moment("ISSUER-A", "settle_split", "qr-6", "0"),
        moment("WORKER-CODE", "transfer_claim", undefined, "5000"), // names no quote: settles nothing
      ],
      capacityEvents: [
        { kind: "pay_with_claim", agentId: "WORKER-EXTRACT", quantityMilliSiu: "1184" },
        { kind: "settle_split", agentId: "ISSUER-A", quantityMilliSiu: "592" },
        { kind: "transfer_claim", agentId: "ORCHESTRATOR", quantityMilliSiu: "1184" },
      ],
      needsMet: { "TRADER-1": 2, "TRADER-2": 1, "TRADER-3": 1, "TRADER-4": 1 },
      operatorActions: [
        { kind: "expiry", holder: "TRADER-1", quantityMilliSiu: "816" },
        { kind: "expiry", holder: "ISSUER-B", quantityMilliSiu: "9999" },
        { kind: "fee_rebate" },
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
    expect(m.paymentsByRoute).toEqual({ usdc: 1, mint_forward: 1, held: 3, split: 1 });
    expect(of("TRADER-2").jobsBoughtBy).toEqual({ usdc: 0, mint_forward: 0, held: 1, split: 0 });
    expect(of("TRADER-2").rawBoughtBy).toEqual({ usdc: 0, mint_forward: 0, held: 1, split: 0 });
    expect(m.fsiuShareOfPayments).toBe("0.833"); // five of six payments were not wholly in dollars
  });

  it("reports what each trader disposed of: passed on, redeemed for raw work, expired", () => {
    expect(of("TRADER-1").passedOnMilliSiu).toBe("1184");
    expect(of("TRADER-2")).toMatchObject({ passedOnMilliSiu: "1184", redeemedForRawWorkMilliSiu: "975", redeemedFromHeldMilliSiu: "975" });
    expect(of("TRADER-1").expiredMilliSiu).toBe("816");
    // The issuer's and the operator's leftovers are not a trader's disposal.
    expect(m.traders.map((t) => t.expiredMilliSiu)).toEqual(["816", "0", "0", "0"]);
  });

  it("counts mints per job transacted", () => {
    expect(m.mints).toBe(2); // the transfer is not a mint
    expect(m.jobsTransacted).toBe(5);
    expect(m.mintsPerJob).toBe("0.400");
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
    ["a run stopped by an agent's own ceiling", { haltedReason: { "WORKER-EXTRACT": "ceiling" } }, /spending cap/],
    ["a run made before versions were stamped", { instrument: undefined }, /before versions were stamped.*current version/],
    ["a run made under an earlier version of the lab", { instrument: { version: LAB_INSTRUMENT_VERSION - 1 } }, /version 2, not the current version 3/],
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
  // D8, D23: a claim paid to the issuer is a redemption in effect, whichever way it came to be paid.
  const raw = (id: string, buyer: string) => sale(id, "rawwork", buyer, "ISSUER");
  const r = base({
    sales: [raw("qr-1", "TRADER-1"), raw("qr-2", "TRADER-2"), raw("qr-3", "TRADER-3"), raw("qr-4", "TRADER-4")],
    paymentMoments: [
      moment("ORCHESTRATOR", "transfer_claim", "qr-1", "0", "0.0014"), // a held claim
      moment("WORKER-CODE", "pay_with_claim", "qr-2", "0", "0.0014"), // minted and forwarded
      moment("WORKER-EXTRACT", "settle_split", "qr-3", "0", "0.0014"), // the claim part of a split
      moment("ISSUER-A", "pay", "qr-4", "0", "0.0014"), // dollars: no claim reaches the issuer
    ],
    capacityEvents: [
      { kind: "transfer_claim", agentId: "ORCHESTRATOR", quantityMilliSiu: "975", settlesRequestId: "qr-1" },
      { kind: "pay_with_claim", agentId: "WORKER-CODE", quantityMilliSiu: "975", settlesRequestId: "qr-2" },
      { kind: "settle_split", agentId: "WORKER-EXTRACT", quantityMilliSiu: "487", settlesRequestId: "qr-3" },
    ],
    operatorActions: [{ kind: "expiry", holder: "ISSUER-B", quantityMilliSiu: "2437" }],
  });
  const m = measureRun(r);
  const of = (t: string) => m.traders.find((x) => x.trader === t)!;

  it("counts every claim paid to the issuer as redeemed for raw work, and says which were held and which were minted", () => {
    expect(of("TRADER-1")).toMatchObject({ redeemedForRawWorkMilliSiu: "975", redeemedFromHeldMilliSiu: "975", redeemedMintedMilliSiu: "0" });
    expect(of("TRADER-2")).toMatchObject({ redeemedForRawWorkMilliSiu: "975", redeemedFromHeldMilliSiu: "0", redeemedMintedMilliSiu: "975" });
    expect(of("TRADER-3")).toMatchObject({ redeemedForRawWorkMilliSiu: "487", redeemedMintedMilliSiu: "487" }); // the quantity the loop recorded
    expect(of("TRADER-4")).toMatchObject({ redeemedForRawWorkMilliSiu: "0" }); // paid in dollars
  });

  it("reports what the issuer was left holding at the close — it can pass none of it on", () => {
    expect(m.leftWithIssuerMilliSiu).toBe("2437");
  });
});
