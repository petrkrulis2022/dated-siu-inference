/**
 * What a lab run measured, derived from its report alone, and the draft decision rule over many runs
 * (`docs/marketplace_plan.md` §3 and §6). Nothing here reads a chain or a log: the report holds the loop's own
 * payment records, the books' sales, the operator's actions and the snapshots, so a number here can be
 * recomputed by anyone holding the report.
 *
 * The rule reads a bootstrap interval over RUNS, not a Wilson interval on pooled opportunities (D20): decisions
 * within a run share its agents, balances and history, so they are not independent, and an interval that treats
 * them so is narrower than the evidence. The pooled Wilson interval is reported beside it and is not read.
 *
 * Definitions, as the plan states them (re-registered for instrument v4, D30 to D33):
 *   fSIU use      — a payment to a trader, or a raw-work purchase, made from a held fSIU balance, wholly or in the claim
 *                   part of a split. Nothing is minted after the opening, so there is no other way to pay in fSIU.
 *   opportunity   — any payment or raw-work purchase, in any asset, made while the trader held RECEIVED fSIU at
 *                   least as large as the amount due. Declining to use it counts.
 *   reuse         — an opportunity paid wholly from the held fSIU, the claim taken from what the trader received first:
 *                   a transfer of a held claim. A split that spends received fSIU in part is PARTIAL reuse, reported
 *                   apart and not read by the decision rule.
 *
 * "Received" is fSIU another agent handed the trader. The opening endowment is the operator's and is not received by
 * the trader; a held-balance payment funded by it is reported apart.
 */
import { D } from "@touchstone/sdk";
import { assertCountableForF1 } from "../cli/debug-mode.js";
import { LAB_TRADERS, type LabParams, type TraderLabel } from "./economy.js";
import { mulberry32 } from "@touchstone/basket";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import { claimForUsd, jobSiu, printNano, quotedPrice, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "./money.js";

/** The parts of a report this reads. Structural, so a test can build one by hand. */
export interface MeasureReport {
  runId: string;
  seed: number;
  scripted: boolean;
  params: LabParams;
  print: { rateUsdPerSiu: string };
  seats: Record<string, string>;
  economy: { needs: { id: string; buyer: string; seller: string; round: number }[] };
  /** The scenario print in each round (D41), nano-USD per SIU, round 1 first. A report made before it moved has none. */
  prints?: { byRound: string[]; stepBps: number };
  /** What each trader opened with, in mSIU: the figure a holding is measured as a fraction of. */
  opening?: { fsiuMilliSiuPerTrader: string };
  sales: { requestId: string; round?: number; kind: "trade" | "rawwork"; buyer: string; seller: string; delivered: boolean }[];
  paymentMoments: { agentId: string; tool: string; requestId?: string; heldReceivedMilliSiu: string; quotedUsdMax?: string }[];
  capacityEvents: { kind: string; agentId: string; quantityMilliSiu?: string; settlesRequestId?: string; counterparty?: string }[];
  /** Every wait, and what was on the screen it waited on (D34). A report made before the record has none. */
  waits?: { agentId: string; turn: number; hadWork: string[] }[];
  operatorActions: { kind: string; [k: string]: unknown }[];
  snapshots: { label: string; round: number; traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string; needsMet: number; resultNano: string }[] }[];
  final?: { traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string; needsMet: number; resultNano: string }[] };
  measuredBeforeClose?: boolean;
  needsMet: Record<string, number>;
  /** Why each agent stopped taking turns. */
  haltedReason?: Record<string, string>;
  totalRealizedUsd: string;
  workCostUsd: string;
  labErrors: unknown[];
  abortedBecause?: string;
  contamination?: string;
  infrastructureFailure?: unknown;
  pool: { whole: boolean; restored?: boolean };
  /** Which lab the run was made in (`lab/instrument.ts`). A report with none predates the stamp. */
  instrument?: { version: number };
  /** The shape `assertCountableForF1` reads. Set by the runner; recomputed here and never trusted alone. */
  debugMode?: { disqualifiedBecause?: string | null };
}

/**
 * Why this run cannot be counted, or null. Recomputed from the report's own facts; the runner stamps the same
 * answer into `debugMode.disqualifiedBecause` so the existing guard reads it.
 */
export function labDisqualification(r: MeasureReport): string | null {
  if (r.scripted) return "a scripted walk: no model was called, so there is no behaviour to count";
  // A change to what the lab is makes an earlier run a different instrument, which is never pooled with this one.
  if (r.instrument?.version !== LAB_INSTRUMENT_VERSION) {
    return (
      `made in lab instrument ${r.instrument?.version === undefined ? "before versions were stamped" : `version ${r.instrument.version}`}, ` +
      `not the current version ${LAB_INSTRUMENT_VERSION}: a rule an agent meets has changed since (lab/instrument.ts)`
    );
  }
  if (r.abortedBecause !== undefined) return `the run aborted: ${r.abortedBecause}`;
  if (r.contamination !== undefined) return `the run was contaminated: ${r.contamination}`;
  if (r.infrastructureFailure !== undefined) return "the harness failed (an empty completion at the token budget, twice)";
  if (r.labErrors.length > 0) return `${r.labErrors.length} failure(s) of the lab's own bookkeeping`;
  // A spending cap that stops the loop ends the run for reasons that are not its agents'. The first model run was
  // cut after about 125 turns by a cap set too low, and round 3 never opened.
  const capped = Object.entries(r.haltedReason ?? {}).filter(([, why]) => why === "experiment_halt" || why === "ceiling");
  if (capped.length > 0) return `the run was stopped by a spending cap, not by its agents (${capped.map(([a, w]) => `${a}: ${w}`).join(", ")})`;
  // A seat stopped by its provider (an account out of credit, a node that errored) did not stop for any reason of its own, so what the run
  // shows of that seat's behaviour is cut short by the environment. Found by the first v6 run: OpenRouter answered 402 on one seat's twelfth turn,
  // the seat never delivered a job it had been paid for in fSIU, and the report still called the run countable (D46).
  const stopped = Object.entries(r.haltedReason ?? {}).filter(([, why]) => why === "adapter_error" || why === "run_infrastructure_failed" || why === "validation_failed");
  if (stopped.length > 0) {
    return `a seat was stopped by its provider or the harness, not by its own choices (${stopped.map(([a, w]) => `${a}: ${w}`).join(", ")}), so the run shows less than the agents would have done`;
  }
  if (!r.pool.whole) return "the run started from a pool that was not whole, so it is not comparable with one that did";
  if (r.pool.restored !== true) return "the pool was not restored after the run";
  if (r.final === undefined) return "no scoring snapshot was taken";
  if (r.measuredBeforeClose !== true) return "the scoring snapshot was taken after the window closed";
  return null;
}

/** The existing guard, with the recomputed reason added: throws unless the run may be counted. */
export function assertCountableForLab(r: MeasureReport): void {
  const why = labDisqualification(r);
  assertCountableForF1({ runId: r.runId, debugMode: { disqualifiedBecause: r.debugMode?.disqualifiedBecause ?? why } });
  if (why !== null) {
    throw new Error(`${r.runId} cannot count toward the lab's result: ${why}.`);
  }
}

type Route = "usdc" | "held" | "split";
const ROUTE_OF_TOOL: Record<string, Route> = { pay: "usdc", transfer_claim: "held", settle_split_held: "split" };
const zeroRoutes = (): Record<Route, number> => ({ usdc: 0, held: 0, split: 0 });

export interface TraderMeasures {
  trader: TraderLabel;
  /** Payments made, by what was bought and how. */
  jobsBoughtBy: Record<Route, number>;
  rawBoughtBy: Record<Route, number>;
  opportunities: number;
  reuse: number;
  /** Splits made while the trader held received fSIU, and how much of the claim part came from it (reported apart, D32). */
  partialReuse: number;
  partialReuseMilliSiu: string;
  /** Held-balance payments whose amount exceeded what the trader had RECEIVED: funded, at least in part, by the opening. */
  heldFundedByOpening: number;
  /** mSIU of held claims passed on to a trader in payment for a job. */
  passedOnMilliSiu: string;
  /**
   * mSIU paid to the issuer for raw work, by any route (D23): a claim paid to the issuer is a redemption in effect,
   * since the issuer is the one that owes the work.
   */
  redeemedForRawWorkMilliSiu: string;
  /** Waits taken, and how many of them with something on the screen to act on (D34). */
  waits: number;
  waitedWithWork: number;
  /** mSIU left at the close and expired. */
  expiredMilliSiu: string;
  needsMet: number;
  resultNano: string;
  openingResultNano: string;
}

export interface HoldingsRow {
  label: string;
  round: number;
  trader: TraderLabel;
  fsiuMilliSiu: string;
  /** Needs this trader has not yet met, and what buying each by claim would take. */
  unmetNeeds: number;
  upcomingNeedsMilliSiu: string;
  /**
   * Raw work its schedule says it will need from this round on: one unit for each job it is to sell in a round at or after this
   * one (D41, H2). What a unit costs in fSIU is about 1 SIU at every print, so the figure in mSIU is at this round's print.
   */
  upcomingRawUnits: number;
  upcomingRawWorkMilliSiu: string;
  /** fSIU held as a fraction of what the trader opened with (1 is none spent). Absent on the final row, which is not a round start. */
  heldFraction?: number;
}

/** One trader's holding at the start of one round, against whether its schedule has it needing raw work from then on. */
export interface H2Row {
  trader: TraderLabel;
  round: number;
  heldFraction: number;
  upcomingRawUnits: number;
}

/** The two groups of H2, per run: trader-rounds whose schedule has raw work still to buy, and those whose has none. */
export interface H2Counts {
  withN: number;
  withSum: number;
  withoutN: number;
  withoutSum: number;
}

export interface RunMeasures {
  runId: string;
  seed: number;
  countable: boolean;
  disqualifiedBecause: string | null;
  opportunities: number;
  reuse: number;
  partialReuse: number;
  /** Waits taken while there was something to act on, over all traders (D34). */
  waitedWithWork: number;
  traders: TraderMeasures[];
  paymentsByRoute: Record<Route, number>;
  /** Payments that were not wholly in dollars, over all payments. */
  fsiuShareOfPayments: string;
  jobsTransacted: number;
  /** Needs met, over all needs. */
  needsMet: number;
  needsTotal: number;
  holdings: HoldingsRow[];
  h2: { rows: H2Row[]; counts: H2Counts };
  /** mSIU the issuer was left holding at the close and expired. The issuer service has no tool that passes a claim on. */
  leftWithIssuerMilliSiu: string;
  costUsd: string;
}

const ratio = (n: number, d: number): string => (d === 0 ? "n/a" : (n / d).toFixed(3));

export function measureRun(r: MeasureReport): RunMeasures {
  const p = printNano(r.print.rateUsdPerSiu);
  const labelOfSeat = Object.fromEntries(Object.entries(r.seats).map(([label, seat]) => [seat, label])) as Record<string, TraderLabel>;
  const saleOf = new Map(r.sales.map((s) => [s.requestId, s]));
  const per = new Map<TraderLabel, TraderMeasures>(
    LAB_TRADERS.map((t) => [
      t,
      {
        trader: t,
        jobsBoughtBy: zeroRoutes(),
        rawBoughtBy: zeroRoutes(),
        opportunities: 0,
        reuse: 0,
        partialReuse: 0,
        partialReuseMilliSiu: "0",
        heldFundedByOpening: 0,
        passedOnMilliSiu: "0",
        redeemedForRawWorkMilliSiu: "0",
        waits: 0,
        waitedWithWork: 0,
        expiredMilliSiu: "0",
        needsMet: r.needsMet[t] ?? 0,
        resultNano: r.final?.traders.find((x) => x.trader === t)?.resultNano ?? "0",
        openingResultNano: r.snapshots[0]?.traders.find((x) => x.trader === t)?.resultNano ?? "0",
      },
    ]),
  );
  const add = (a: string, b: bigint): string => (BigInt(a) + b).toString();

  // The claim each payment moved, from the loop's own capacity event for it; the quote's sizing only if absent.
  const movedBy = new Map<string, bigint>();
  for (const e of r.capacityEvents) {
    if (e.settlesRequestId !== undefined && e.quantityMilliSiu !== undefined) movedBy.set(e.settlesRequestId, BigInt(e.quantityMilliSiu));
  }

  const paymentsByRoute = zeroRoutes();
  let opportunities = 0;
  let reuse = 0;
  let partialReuse = 0;
  for (const m of r.paymentMoments) {
    const trader = labelOfSeat[m.agentId];
    const route = ROUTE_OF_TOOL[m.tool];
    const sale = m.requestId === undefined ? undefined : saleOf.get(m.requestId);
    // A payment that names no quote settles nothing; it is a disposal, counted below, not a purchase.
    if (trader === undefined || route === undefined || sale === undefined || m.quotedUsdMax === undefined) continue;
    const t = per.get(trader)!;
    (sale.kind === "trade" ? t.jobsBoughtBy : t.rawBoughtBy)[route] += 1;
    paymentsByRoute[route] += 1;

    // The amount due is the quote's price at the print of the round the quote was asked for in (D41), which is what a claim is sized at.
    const askedAt = sale.round !== undefined && r.prints !== undefined ? BigInt(r.prints.byRound[sale.round - 1] ?? p) : p;
    const due = claimForUsd(m.quotedUsdMax, askedAt);
    const heldReceived = BigInt(m.heldReceivedMilliSiu);
    const isOpportunity = heldReceived >= due;
    if (isOpportunity) {
      t.opportunities += 1;
      opportunities += 1;
      if (route === "held") {
        t.reuse += 1;
        reuse += 1;
      }
    }
    if (route === "held" && !isOpportunity) t.heldFundedByOpening += 1;
    if (route !== "usdc") {
      const moved = movedBy.get(m.requestId!) ?? due;
      // A split that spends received fSIU in part: the claim part, up to what had been received, is partial reuse.
      if (route === "split" && heldReceived > 0n) {
        t.partialReuse += 1;
        partialReuse += 1;
        t.partialReuseMilliSiu = add(t.partialReuseMilliSiu, moved < heldReceived ? moved : heldReceived);
      }
      if (sale.kind === "rawwork") t.redeemedForRawWorkMilliSiu = add(t.redeemedForRawWorkMilliSiu, moved);
      else t.passedOnMilliSiu = add(t.passedOnMilliSiu, moved);
    }
  }

  let waitedWithWork = 0;
  for (const w of r.waits ?? []) {
    const trader = labelOfSeat[w.agentId];
    if (trader === undefined) continue; // the issuer service's waits are not a trader's
    const t = per.get(trader)!;
    t.waits += 1;
    if (w.hadWork.length > 0) {
      t.waitedWithWork += 1;
      waitedWithWork += 1;
    }
  }

  for (const a of r.operatorActions) {
    if (a.kind !== "expiry") continue;
    const holder = String(a.holder);
    if ((LAB_TRADERS as readonly string[]).includes(holder)) {
      const t = per.get(holder as TraderLabel)!;
      t.expiredMilliSiu = add(t.expiredMilliSiu, BigInt(String(a.quantityMilliSiu)));
    }
  }

  const jobsTransacted = Object.values(r.needsMet).reduce((a, b) => a + b, 0);

  // Holdings against what each trader still needs to buy, at each snapshot.
  const size = jobSiu(r.params);
  const jobClaim = claimForUsd(quotedPrice(size, tradeRateUsdPerSiu(p, r.params)).usd, p);
  const needsOf = (t: TraderLabel): number => r.economy.needs.filter((n) => n.buyer === t).length;
  const openingFsiu = BigInt(r.opening?.fsiuMilliSiuPerTrader ?? r.snapshots[0]?.traders[0]?.fsiuMilliSiu ?? "0");
  const rawClaimAt = (round: number): bigint => {
    const rp = r.prints !== undefined ? BigInt(r.prints.byRound[round - 1] ?? p) : p;
    return claimForUsd(quotedPrice(size, rawWorkRateUsdPerSiu(rp)).usd, rp);
  };
  const holdings: HoldingsRow[] = [
    ...r.snapshots,
    ...(r.final !== undefined ? [{ label: "final", round: r.snapshots.at(-1)?.round ?? 0, traders: r.final.traders }] : []),
  ].flatMap((s) =>
    s.traders.map((x) => {
      const unmet = needsOf(x.trader as TraderLabel) - x.needsMet;
      const upcomingRawUnits = r.economy.needs.filter((n) => n.seller === x.trader && n.round >= s.round).length;
      return {
        label: s.label,
        round: s.round,
        trader: x.trader as TraderLabel,
        fsiuMilliSiu: x.fsiuMilliSiu,
        unmetNeeds: unmet,
        upcomingNeedsMilliSiu: (BigInt(unmet) * jobClaim).toString(),
        upcomingRawUnits,
        upcomingRawWorkMilliSiu: (BigInt(upcomingRawUnits) * rawClaimAt(s.round)).toString(),
        ...(s.label !== "final" && openingFsiu > 0n ? { heldFraction: Number((BigInt(x.fsiuMilliSiu) * 10_000n) / openingFsiu) / 10_000 } : {}),
      };
    }),
  );
  // H2's rows: every trader at the start of every round (round 1 is the opening). Never the final row, which is the end of the run.
  const h2Rows: H2Row[] = holdings
    .filter((h) => h.label !== "final" && h.heldFraction !== undefined)
    .map((h) => ({ trader: h.trader, round: h.round, heldFraction: h.heldFraction!, upcomingRawUnits: h.upcomingRawUnits }));
  const h2Counts: H2Counts = { withN: 0, withSum: 0, withoutN: 0, withoutSum: 0 };
  for (const row of h2Rows) {
    if (row.upcomingRawUnits > 0) {
      h2Counts.withN += 1;
      h2Counts.withSum += row.heldFraction;
    } else {
      h2Counts.withoutN += 1;
      h2Counts.withoutSum += row.heldFraction;
    }
  }

  const total = paymentsByRoute.usdc + paymentsByRoute.held + paymentsByRoute.split;
  const why = labDisqualification(r) ?? r.debugMode?.disqualifiedBecause ?? null;
  return {
    runId: r.runId,
    seed: r.seed,
    countable: why === null,
    disqualifiedBecause: why,
    opportunities,
    reuse,
    partialReuse,
    waitedWithWork,
    traders: [...per.values()],
    paymentsByRoute,
    fsiuShareOfPayments: ratio(total - paymentsByRoute.usdc, total),
    jobsTransacted,
    needsMet: jobsTransacted,
    needsTotal: r.economy.needs.length,
    holdings,
    h2: { rows: h2Rows, counts: h2Counts },
    leftWithIssuerMilliSiu: r.operatorActions
      .filter((a) => a.kind === "expiry" && a.holder === "ISSUER-B")
      .reduce((sum, a) => sum + BigInt(String(a.quantityMilliSiu)), 0n)
      .toString(),
    costUsd: new D(r.totalRealizedUsd).plus(new D(r.workCostUsd)).toFixed(6),
  };
}

// ---------------------------------------------------------------------------------------------------
// Statistics and the decision rule. Rates are proportions, not money: ordinary floats are right here.
// ---------------------------------------------------------------------------------------------------

export interface Interval {
  successes: number;
  n: number;
  rate: number;
  lower: number;
  upper: number;
}

/** The 95% Wilson score interval for a proportion. `n = 0` has no interval and says so. */
export function wilson(successes: number, n: number, z = 1.959963984540054): Interval {
  if (n === 0) return { successes, n, rate: Number.NaN, lower: Number.NaN, upper: Number.NaN };
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { successes, n, rate: p, lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Plan §3 (approved, D20): below this many pooled opportunities nothing can be said. */
export const MIN_OPPORTUNITIES = 30;
/** …and unless this many runs each contribute at least one, a few busy runs could decide the result. */
export const MIN_RUNS_WITH_OPPORTUNITY = 10;
export const CIRCULATES_LOWER_BOUND = 0.5;
export const DOES_NOT_CIRCULATE_UPPER_BOUND = 0.2;
/** The bootstrap: draws, and a fixed seed so the interval is the same every time it is computed. */
export const BOOTSTRAP_DRAWS = 10_000;
export const BOOTSTRAP_SEED = 20_261_006;

export interface RunCounts {
  opportunities: number;
  reuse: number;
}

/** A percentile interval from resampling whole runs. `discarded` draws had no opportunity and so no rate. */
export interface RunInterval {
  rate: number;
  lower: number;
  upper: number;
  runs: number;
  draws: number;
  discarded: number;
  seed: number;
}

/**
 * The 95% bootstrap interval over runs: draw as many runs as there are, with replacement, pool their counts into
 * one rate, repeat, and take the 2.5th and 97.5th percentiles of the rates. Runs, not decisions, are the unit
 * resampled, because decisions within a run move together (D20).
 */
export function bootstrapOverRuns(
  runs: readonly RunCounts[],
  options: { draws?: number; seed?: number } = {},
): RunInterval {
  const draws = options.draws ?? BOOTSTRAP_DRAWS;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const totalOpps = runs.reduce((s, r) => s + r.opportunities, 0);
  const totalReuse = runs.reduce((s, r) => s + r.reuse, 0);
  const rate = totalOpps === 0 ? Number.NaN : totalReuse / totalOpps;
  if (runs.length === 0 || totalOpps === 0) {
    return { rate, lower: Number.NaN, upper: Number.NaN, runs: runs.length, draws, discarded: draws, seed };
  }
  const rng = mulberry32(seed);
  const rates: number[] = [];
  for (let d = 0; d < draws; d++) {
    let opps = 0;
    let reuse = 0;
    for (let i = 0; i < runs.length; i++) {
      const pick = runs[Math.floor(rng() * runs.length)];
      opps += pick.opportunities;
      reuse += pick.reuse;
    }
    if (opps > 0) rates.push(reuse / opps);
  }
  rates.sort((a, b) => a - b);
  const at = (q: number): number => rates[Math.min(rates.length - 1, Math.max(0, Math.round(q * (rates.length - 1))))];
  return { rate, lower: at(0.025), upper: at(0.975), runs: runs.length, draws, discarded: draws - rates.length, seed };
}

export type Verdict = "inconclusive" | "circulates" | "does not circulate" | "no detectable effect at this sample size";

/**
 * Plan §3. Inconclusive on too few opportunities, or too few runs that contribute one; otherwise the
 * run-resampled interval decides.
 */
export function decide(input: { opportunities: number; runsWithOpportunity: number; interval: { lower: number; upper: number } }): Verdict {
  if (input.opportunities < MIN_OPPORTUNITIES) return "inconclusive";
  if (input.runsWithOpportunity < MIN_RUNS_WITH_OPPORTUNITY) return "inconclusive";
  if (input.interval.lower >= CIRCULATES_LOWER_BOUND) return "circulates";
  if (input.interval.upper < DOES_NOT_CIRCULATE_UPPER_BOUND) return "does not circulate";
  return "no detectable effect at this sample size";
}

export interface Pooled {
  runsAdmitted: number;
  runsExcluded: { runId: string; because: string }[];
  /** The interval the rule reads: resampled over runs. */
  interval: RunInterval;
  /** Reported beside it, for comparison; the rule does not read it. */
  wilson: Interval;
  verdict: Verdict;
  opportunities: number;
  reuse: number;
  /** Of runs with at least one opportunity, how many reused a majority of theirs. */
  runsWithOpportunity: number;
  runsWithMajorityReused: number;
  /** H2: fSIU held at each round's start against the raw work still to buy (D41). */
  h2: H2Pooled;
}

/**
 * Pools the runs a report may admit. Every one passes `assertCountableForLab` first — the guard throws, so a
 * scripted walk or an aborted run cannot be pooled by accident — and what cannot be admitted is listed, with
 * its reason, rather than dropped.
 */
export function pool(reports: readonly MeasureReport[]): Pooled {
  const excluded: { runId: string; because: string }[] = [];
  const measured: RunMeasures[] = [];
  for (const r of reports) {
    try {
      assertCountableForLab(r);
      measured.push(measureRun(r));
    } catch (err) {
      excluded.push({ runId: r.runId, because: err instanceof Error ? err.message : String(err) });
    }
  }
  const opportunities = measured.reduce((s, m) => s + m.opportunities, 0);
  const reuse = measured.reduce((s, m) => s + m.reuse, 0);
  const withOpp = measured.filter((m) => m.opportunities > 0);
  const interval = bootstrapOverRuns(measured.map((m) => ({ opportunities: m.opportunities, reuse: m.reuse })));
  return {
    runsAdmitted: measured.length,
    runsExcluded: excluded,
    interval,
    wilson: wilson(reuse, opportunities),
    verdict: decide({ opportunities, runsWithOpportunity: withOpp.length, interval }),
    opportunities,
    reuse,
    runsWithOpportunity: withOpp.length,
    runsWithMajorityReused: withOpp.filter((m) => m.reuse * 2 > m.opportunities).length,
    h2: poolH2(measured),
  };
}

/** Plan §3, arm comparison: an effect only if the (run-resampled) intervals do not overlap. */
export function compareArms(
  a: { lower: number; upper: number },
  b: { lower: number; upper: number },
): "effect" | "no detectable effect at this sample size" {
  if ([a.lower, a.upper, b.lower, b.upper].some(Number.isNaN)) return "no detectable effect at this sample size";
  return a.lower > b.upper || b.lower > a.upper ? "effect" : "no detectable effect at this sample size";
}

// ---------------------------------------------------------------------------------------------------
// H2, registered for instrument v6 (plan §3, D41): a trader's fSIU holding at the start of each round tracks the raw work its
// schedule says it will need from then on — holding fSIU as a hedge against the price of work. Thresholds PROPOSED before any
// result, to be changed only before the block.
// ---------------------------------------------------------------------------------------------------

/** Fewer pooled trader-rounds with NO raw work still to buy than this, and nothing can be said. */
export const H2_MIN_TRADER_ROUNDS_WITHOUT = 30;
/** …and unless this many runs each contribute trader-rounds to both groups, a few runs could decide the result. */
export const H2_MIN_RUNS_WITH_BOTH = 10;
/** Supported: the difference's interval sits at or above this lower bound and the point estimate is at least the point threshold. */
export const H2_SUPPORT_LOWER_BOUND = 0.1;
export const H2_SUPPORT_POINT = 0.2;
/** Not supported: the difference's interval sits entirely below this. */
export const H2_REJECT_UPPER_BOUND = 0.1;

export interface H2Interval {
  /** mean held fraction of trader-rounds with raw work still to buy, minus those without. */
  delta: number;
  lower: number;
  upper: number;
  runs: number;
  draws: number;
  discarded: number;
  seed: number;
}

/**
 * The 95% bootstrap interval over runs for the difference in mean held fraction between trader-rounds that have raw work still to
 * buy and those that do not: draw as many runs as there are, with replacement, pool their trader-rounds, take the difference,
 * repeat. Runs are resampled, not trader-rounds, for the reason H1's interval resamples runs (D20). A draw in which either
 * group is empty has no difference and is left out.
 */
export function bootstrapH2(runs: readonly H2Counts[], options: { draws?: number; seed?: number } = {}): H2Interval {
  const draws = options.draws ?? BOOTSTRAP_DRAWS;
  const seed = options.seed ?? BOOTSTRAP_SEED;
  const diff = (c: H2Counts): number => c.withSum / c.withN - c.withoutSum / c.withoutN;
  const total = runs.reduce<H2Counts>(
    (a, c) => ({ withN: a.withN + c.withN, withSum: a.withSum + c.withSum, withoutN: a.withoutN + c.withoutN, withoutSum: a.withoutSum + c.withoutSum }),
    { withN: 0, withSum: 0, withoutN: 0, withoutSum: 0 },
  );
  if (runs.length === 0 || total.withN === 0 || total.withoutN === 0) {
    return { delta: Number.NaN, lower: Number.NaN, upper: Number.NaN, runs: runs.length, draws, discarded: draws, seed };
  }
  const rng = mulberry32(seed);
  const deltas: number[] = [];
  for (let d = 0; d < draws; d++) {
    const acc: H2Counts = { withN: 0, withSum: 0, withoutN: 0, withoutSum: 0 };
    for (let i = 0; i < runs.length; i++) {
      const pick = runs[Math.floor(rng() * runs.length)];
      acc.withN += pick.withN;
      acc.withSum += pick.withSum;
      acc.withoutN += pick.withoutN;
      acc.withoutSum += pick.withoutSum;
    }
    if (acc.withN > 0 && acc.withoutN > 0) deltas.push(diff(acc));
  }
  deltas.sort((a, b) => a - b);
  const at = (q: number): number => deltas[Math.min(deltas.length - 1, Math.max(0, Math.round(q * (deltas.length - 1))))];
  return { delta: diff(total), lower: at(0.025), upper: at(0.975), runs: runs.length, draws, discarded: draws - deltas.length, seed };
}

export type H2Verdict = "inconclusive" | "supported" | "not supported" | "no detectable effect at this sample size";

export function decideH2(input: { traderRoundsWithout: number; runsWithBoth: number; interval: { delta: number; lower: number; upper: number } }): H2Verdict {
  if (input.traderRoundsWithout < H2_MIN_TRADER_ROUNDS_WITHOUT) return "inconclusive";
  if (input.runsWithBoth < H2_MIN_RUNS_WITH_BOTH) return "inconclusive";
  if (input.interval.lower >= H2_SUPPORT_LOWER_BOUND && input.interval.delta >= H2_SUPPORT_POINT) return "supported";
  if (input.interval.upper < H2_REJECT_UPPER_BOUND) return "not supported";
  return "no detectable effect at this sample size";
}

export interface H2Pooled {
  interval: H2Interval;
  verdict: H2Verdict;
  traderRoundsWith: number;
  traderRoundsWithout: number;
  runsWithBoth: number;
  meanHeldWith: number;
  meanHeldWithout: number;
}

export function poolH2(measured: readonly RunMeasures[]): H2Pooled {
  const counts = measured.map((m) => m.h2.counts);
  const both = counts.filter((c) => c.withN > 0 && c.withoutN > 0);
  const withN = counts.reduce((s, c) => s + c.withN, 0);
  const withoutN = counts.reduce((s, c) => s + c.withoutN, 0);
  const interval = bootstrapH2(counts);
  return {
    interval,
    verdict: decideH2({ traderRoundsWithout: withoutN, runsWithBoth: both.length, interval }),
    traderRoundsWith: withN,
    traderRoundsWithout: withoutN,
    runsWithBoth: both.length,
    meanHeldWith: withN === 0 ? Number.NaN : counts.reduce((s, c) => s + c.withSum, 0) / withN,
    meanHeldWithout: withoutN === 0 ? Number.NaN : counts.reduce((s, c) => s + c.withoutSum, 0) / withoutN,
  };
}

export function renderPooled(p: Pooled): string {
  const pct = (x: number): string => (Number.isNaN(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);
  const i = p.interval;
  const w = p.wilson;
  const lines = [
    "LAB RESULT (pooled over the runs a report may admit)",
    `  runs admitted ${p.runsAdmitted}; excluded ${p.runsExcluded.length}`,
    ...p.runsExcluded.map((e) => `    excluded ${e.runId}: ${e.because}`),
    `  opportunities ${p.opportunities}, reused ${p.reuse}, reuse rate ${pct(i.rate)}`,
    `  runs with an opportunity ${p.runsWithOpportunity} of ${p.runsAdmitted} (the rule needs ${MIN_RUNS_WITH_OPPORTUNITY}); of those, a majority reused in ${p.runsWithMajorityReused}`,
    `  interval the rule reads — 95% bootstrap over runs (${i.draws} draws, seed ${i.seed}, ${i.discarded} with no opportunity left out): ${pct(i.lower)} to ${pct(i.upper)}`,
    `  beside it, not read — pooled Wilson: ${pct(w.lower)} to ${pct(w.upper)}`,
    `  verdict under the approved rule: ${p.verdict.toUpperCase()}`,
    "",
    "H2 (fSIU held at each round's start, as a fraction of the opening, against raw work still to buy — proposed rule, D41)",
    `  trader-rounds with raw work still to buy ${p.h2.traderRoundsWith} (mean held ${pct(p.h2.meanHeldWith)}); without ${p.h2.traderRoundsWithout} (mean held ${pct(p.h2.meanHeldWithout)}); runs contributing both ${p.h2.runsWithBoth} (the rule needs ${H2_MIN_RUNS_WITH_BOTH}, and ${H2_MIN_TRADER_ROUNDS_WITHOUT} trader-rounds without)`,
    `  difference ${pct(p.h2.interval.delta)}; 95% bootstrap over runs (${p.h2.interval.draws} draws, seed ${p.h2.interval.seed}, ${p.h2.interval.discarded} left out): ${pct(p.h2.interval.lower)} to ${pct(p.h2.interval.upper)}`,
    `  verdict under the proposed rule: ${p.h2.verdict.toUpperCase()}`,
  ];
  return lines.join("\n");
}
