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
 * Definitions, as the plan states them:
 *   fSIU use      — a payment to a trader, or a raw-work purchase, made in fSIU (held balance, mint-and-forward).
 *   opportunity   — any payment or raw-work purchase, in any asset, made while the trader held RECEIVED fSIU at
 *                   least as large as the amount due. Declining to use it counts.
 *   reuse         — an opportunity funded from the held received fSIU: a transfer of a held claim.
 *
 * "Received" is fSIU another agent handed the trader. The opening endowment is the operator's and is neither
 * received nor minted by the trader; a held-balance payment funded by it is reported apart.
 */
import { D } from "@touchstone/sdk";
import { assertCountableForF1 } from "../cli/debug-mode.js";
import { LAB_TRADERS, type LabParams, type TraderLabel } from "./economy.js";
import { mulberry32 } from "@touchstone/basket";
import { LAB_INSTRUMENT_VERSION } from "./instrument.js";
import { claimForUsd, jobSiu, printNano, quotedPrice, tradeRateUsdPerSiu } from "./money.js";

/** The parts of a report this reads. Structural, so a test can build one by hand. */
export interface MeasureReport {
  runId: string;
  seed: number;
  scripted: boolean;
  params: LabParams;
  print: { rateUsdPerSiu: string };
  seats: Record<string, string>;
  economy: { needs: { id: string; buyer: string; seller: string; round: number }[] };
  sales: { requestId: string; kind: "trade" | "rawwork"; buyer: string; seller: string; delivered: boolean }[];
  paymentMoments: { agentId: string; tool: string; requestId?: string; heldReceivedMilliSiu: string; quotedUsdMax?: string }[];
  capacityEvents: { kind: string; agentId: string; quantityMilliSiu?: string; settlesRequestId?: string; counterparty?: string }[];
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

type Route = "usdc" | "mint_forward" | "held" | "split";
const ROUTE_OF_TOOL: Record<string, Route> = { pay: "usdc", pay_with_claim: "mint_forward", transfer_claim: "held", settle_split: "split" };
const zeroRoutes = (): Record<Route, number> => ({ usdc: 0, mint_forward: 0, held: 0, split: 0 });

export interface TraderMeasures {
  trader: TraderLabel;
  /** Payments made, by what was bought and how. */
  jobsBoughtBy: Record<Route, number>;
  rawBoughtBy: Record<Route, number>;
  opportunities: number;
  reuse: number;
  /** Held-balance payments whose amount exceeded what the trader had RECEIVED: funded, at least in part, by the opening. */
  heldFundedByOpening: number;
  /** mSIU of held claims passed on to a trader in payment for a job. */
  passedOnMilliSiu: string;
  /**
   * mSIU paid to the issuer for raw work, by any route (D23): a claim paid to the issuer is a redemption in effect,
   * since the issuer is the one that owes the work. Of it, what came out of a held balance and what was newly
   * minted for the purpose (mint-and-forward, or the claim part of a split) are given apart.
   */
  redeemedForRawWorkMilliSiu: string;
  redeemedFromHeldMilliSiu: string;
  redeemedMintedMilliSiu: string;
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
}

export interface RunMeasures {
  runId: string;
  seed: number;
  countable: boolean;
  disqualifiedBecause: string | null;
  opportunities: number;
  reuse: number;
  traders: TraderMeasures[];
  paymentsByRoute: Record<Route, number>;
  /** Payments that were not wholly in dollars, over all payments. */
  fsiuShareOfPayments: string;
  mints: number;
  jobsTransacted: number;
  mintsPerJob: string;
  holdings: HoldingsRow[];
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
        heldFundedByOpening: 0,
        passedOnMilliSiu: "0",
        redeemedForRawWorkMilliSiu: "0",
        redeemedFromHeldMilliSiu: "0",
        redeemedMintedMilliSiu: "0",
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
  for (const m of r.paymentMoments) {
    const trader = labelOfSeat[m.agentId];
    const route = ROUTE_OF_TOOL[m.tool];
    const sale = m.requestId === undefined ? undefined : saleOf.get(m.requestId);
    // A payment that names no quote settles nothing; it is a disposal, counted below, not a purchase.
    if (trader === undefined || route === undefined || sale === undefined || m.quotedUsdMax === undefined) continue;
    const t = per.get(trader)!;
    (sale.kind === "trade" ? t.jobsBoughtBy : t.rawBoughtBy)[route] += 1;
    paymentsByRoute[route] += 1;

    const due = claimForUsd(m.quotedUsdMax, p);
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
      if (sale.kind === "rawwork") {
        t.redeemedForRawWorkMilliSiu = add(t.redeemedForRawWorkMilliSiu, moved);
        if (route === "held") t.redeemedFromHeldMilliSiu = add(t.redeemedFromHeldMilliSiu, moved);
        else t.redeemedMintedMilliSiu = add(t.redeemedMintedMilliSiu, moved);
      } else if (route === "held") {
        t.passedOnMilliSiu = add(t.passedOnMilliSiu, moved);
      }
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

  const mints = r.capacityEvents.filter((e) => e.kind === "pay_with_claim" || e.kind === "settle_split" || e.kind === "mint_claim").length;
  const jobsTransacted = Object.values(r.needsMet).reduce((a, b) => a + b, 0);

  // Holdings against what each trader still needs to buy, at each snapshot.
  const size = jobSiu(r.params);
  const jobClaim = claimForUsd(quotedPrice(size, tradeRateUsdPerSiu(p, r.params)).usd, p);
  const needsOf = (t: TraderLabel): number => r.economy.needs.filter((n) => n.buyer === t).length;
  const holdings: HoldingsRow[] = [
    ...r.snapshots,
    ...(r.final !== undefined ? [{ label: "final", round: r.snapshots.at(-1)?.round ?? 0, traders: r.final.traders }] : []),
  ].flatMap((s) =>
    s.traders.map((x) => {
      const unmet = needsOf(x.trader as TraderLabel) - x.needsMet;
      return {
        label: s.label,
        round: s.round,
        trader: x.trader as TraderLabel,
        fsiuMilliSiu: x.fsiuMilliSiu,
        unmetNeeds: unmet,
        upcomingNeedsMilliSiu: (BigInt(unmet) * jobClaim).toString(),
      };
    }),
  );

  const total = paymentsByRoute.usdc + paymentsByRoute.mint_forward + paymentsByRoute.held + paymentsByRoute.split;
  const why = labDisqualification(r) ?? r.debugMode?.disqualifiedBecause ?? null;
  return {
    runId: r.runId,
    seed: r.seed,
    countable: why === null,
    disqualifiedBecause: why,
    opportunities,
    reuse,
    traders: [...per.values()],
    paymentsByRoute,
    fsiuShareOfPayments: ratio(total - paymentsByRoute.usdc, total),
    mints,
    jobsTransacted,
    mintsPerJob: ratio(mints, jobsTransacted),
    holdings,
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
  ];
  return lines.join("\n");
}
