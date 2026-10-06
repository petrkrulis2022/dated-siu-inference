import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import {
  CIRCULATES_LOWER_BOUND,
  MIN_OPPORTUNITIES,
  assertCountableForLab,
  compareArms,
  decide,
  labDisqualification,
  measureRun,
  pool,
  renderPooled,
  wilson,
  type MeasureReport,
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
    expect(of("TRADER-2")).toMatchObject({ passedOnMilliSiu: "1184", redeemedForRawWorkMilliSiu: "975" });
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

describe("the draft decision rule", () => {
  it("is inconclusive below 30 opportunities, whatever the rate", () => {
    expect(decide(wilson(29, 29))).toBe("inconclusive");
    expect(decide(wilson(0, MIN_OPPORTUNITIES - 1))).toBe("inconclusive");
  });
  it("says fSIU circulates only when the interval's lower bound reaches 0.50", () => {
    expect(decide(wilson(28, 30))).toBe("circulates");
    expect(wilson(21, 30).lower).toBeGreaterThanOrEqual(CIRCULATES_LOWER_BOUND);
    expect(decide(wilson(21, 30))).toBe("circulates");
    expect(decide(wilson(20, 30))).toBe("no detectable effect at this sample size");
  });
  it("says it does not circulate only when the upper bound is below 0.20", () => {
    expect(decide(wilson(0, 30))).toBe("does not circulate");
    expect(wilson(1, 30).upper).toBeLessThan(0.2);
    expect(decide(wilson(1, 30))).toBe("does not circulate");
    expect(wilson(2, 30).upper).toBeGreaterThanOrEqual(0.2);
    expect(decide(wilson(2, 30))).toBe("no detectable effect at this sample size");
  });
  it("is never 'no effect': the middle is 'no detectable effect at this sample size'", () => {
    expect(decide(wilson(15, 30))).toBe("no detectable effect at this sample size");
    expect(decide(wilson(15, 30))).not.toMatch(/^no effect/);
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

  it("pools only runs the guard admits, lists the rest with their reason, and applies the rule to the pool", () => {
    const pooled = pool([runWith("a", 10, 0), runWith("b", 9, 1), runWith("c", 9, 1), { ...runWith("walk", 5, 0), scripted: true }, { ...runWith("bad", 5, 0), abortedBecause: "boom" }]);
    expect(pooled.runsAdmitted).toBe(3);
    expect(pooled.runsExcluded.map((e) => e.runId)).toEqual(["walk", "bad"]);
    expect(pooled.runsExcluded[0].because).toMatch(/scripted walk/);
    expect(pooled.interval).toMatchObject({ n: 30, successes: 28 });
    expect(pooled.verdict).toBe("circulates");
    expect(pooled.runsWithOpportunity).toBe(3);
    expect(pooled.runsWithMajorityReused).toBe(3);
  });

  it("counts a run as reusing a majority only when more than half of its opportunities were reused", () => {
    const pooled = pool([runWith("half", 5, 5), runWith("most", 6, 4)]);
    expect(pooled.runsWithMajorityReused).toBe(1);
  });

  it("is inconclusive on too few opportunities even when every one was reused", () => {
    expect(pool([runWith("a", 10, 0)]).verdict).toBe("inconclusive");
  });

  it("renders the verdict beside the interval, in capitals, with every exclusion named", () => {
    const text = renderPooled(pool([runWith("a", 10, 0), { ...runWith("walk", 1, 0), scripted: true }]));
    expect(text).toContain("excluded walk:");
    expect(text).toContain("verdict under the draft rule: INCONCLUSIVE");
  });
});

describe("comparing two arms", () => {
  it("calls it an effect only when the intervals do not overlap", () => {
    expect(compareArms(wilson(28, 30), wilson(2, 30))).toBe("effect");
    expect(compareArms(wilson(20, 30), wilson(15, 30))).toBe("no detectable effect at this sample size");
    expect(compareArms(wilson(0, 0), wilson(15, 30))).toBe("no detectable effect at this sample size");
  });
});
