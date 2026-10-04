/**
 * The five-run block, reported — as a pure function over the runs' own report artefacts.
 *
 * **What it refuses to do.** It does not pool runs that measured different instruments
 * (`assertSameInstrument`), and it does not count a debug run, a run that aborted on a topology
 * precondition, or a report that predates the `f1` block. Each exclusion is listed with its
 * reason; a run that quietly vanished from a block would be a different, worse kind of silence.
 *
 * **F1 is window 1 alone.** Windows 2 and 3 route to an issuer that cannot serve, by design, and
 * answer the enforcement question — so they are reported separately and never folded into a
 * preference figure. Every per-buyer quantity below is computed from window 1.
 *
 * **What it reports as stated, not settled.** Cost per SIU comes from payment moments' quote
 * terms, and `amount_usd_max` is the ceiling a quote allows, not what was finally settled. The
 * label says "quoted"; no figure here is called "paid". fSIU is never given a dollar cost,
 * because no quote states one.
 *
 * Nothing is read from a chain. Everything below comes from fields the runs recorded, and where a
 * field is missing the report says so (`outcomeNotRecorded`, `paymentsWithoutQuote`) instead of
 * filling it in.
 */
import { D } from "@touchstone/sdk";
import { decisionRuleVerdict, type RuleOutcome, type RunOpportunity } from "./decision-rule.js";
import type { F1Report } from "./instrument-report.js";
import { assertSameInstrument } from "./instrument.js";

/**
 * Scoped to window 1 (plan F8): "always redeemable within its window" is false in windows 2 and 3,
 * where the single issuer is non-serving by design, so the caption may not claim it of them.
 */
export const BLOCK_CAPTION =
  "In window 1, fSIU is fungible because the window has a single issuer, and that issuer serves: " +
  "no cross-issuer credit risk, redeemable within the window. That is the best case for fSIU. " +
  "Windows 2 and 3 route to an issuer that cannot serve and measure enforcement, not preference. " +
  "Cross-issuer fungibility and routing are not tested here.";

type Asset = "usdc" | "fsiu" | "split";
const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

export interface ReportEvent {
  kind: string;
  agentId?: string;
  turn?: number;
  issuer?: string;
  quantityMilliSiu?: string;
  forwardDated?: boolean;
  settlementOutcome?: "Defaulted" | "Expired";
  bondPaidMinorUnits?: string;
}
export interface ReportMoment {
  agentId: string;
  turn: number;
  tool: string;
  asset: Asset;
  requestId?: string;
  heldReceivedMilliSiu: string;
  quotedSiu?: string;
  quotedUsdMax?: string;
}
export interface ReportWindow {
  windowIndex: number;
  passed: boolean;
  gateDelivered?: boolean;
  incompleteBecause?: string;
  purchases: {
    decisions: { buyer: string; turn: number; asset: Asset }[];
    journeys: { tokenId: string; hops: number; turnsHeld: number; outcome: string }[];
  };
  paymentMoments?: ReportMoment[];
  capacityEvents: ReportEvent[];
  turnsByAgent: Record<string, number>;
}
export interface RunReport {
  runId: string;
  instrument?: { id: string };
  debugMode?: { disqualifiedBecause?: string | null };
  abortedBecause?: string;
  f1?: F1Report;
  windows: ReportWindow[];
}

export interface Dispersion {
  n: number;
  min: number;
  median: string;
  max: number;
}
export interface Counts {
  usdc: number;
  fsiu: number;
  split: number;
  total: number;
}

export interface WindowSummary {
  windowIndex: number;
  decisions: Counts;
  /** Claims minted this window, by the issuer the router chose — an address, as recorded. */
  allocationByIssuer: Record<string, { mints: number; milliSiu: string }>;
  settlements: { defaulted: number; expired: number; outcomeNotRecorded: number };
  bondPaidMinorUnits: string;
}

export interface BuyerRun {
  decisions: Counts;
  /** fSIU's share of this buyer's window-1 decisions, in basis points, rounded down. Strict:
   *  a `split` is reported as its own count and is not folded into either asset. */
  fsiuShareBp: number | null;
  turns: number | null;
  settledIn: Asset | "mixed" | "none";
  /** `transfer_claim` pushes that settled no quote — a second route to fSIU, counted apart. */
  unkeyedTransfers: number;
}

export interface RunSummary {
  runId: string;
  windowOne: { passed: boolean; gateDelivered: boolean; incompleteBecause?: string };
  f1Clean: boolean | "not_computed";
  buyers: Record<string, BuyerRun>;
  hops: number[];
  turnsHeld: number[];
  windows: WindowSummary[];
  forwardDated: number;
  opportunity: { eligible: boolean; spentOnward: boolean };
}

export interface BlockReport {
  instrument: string;
  caption: string;
  runs: RunSummary[];
  excluded: { runId: string; because: string }[];
  f1: {
    runs: number;
    cleanRuns: number;
    uncleanRuns: string[];
    windowOne: { passed: number; incompleteBecause: Record<string, number> };
    perBuyer: Record<
      string,
      {
        decisions: Counts;
        fsiuShareDispersionBp: Dispersion | null;
        turnsPerPayment: Record<Asset | "mixed", { n: number; mean: string | null; samples: number[] }>;
        unkeyedTransfers: number;
      }
    >;
    hops: { distribution: Record<string, number>; median: string | null };
    turnsHeld: { n: number; median: string | null; min: number | null; max: number | null };
    cost: {
      /** Σ quoted ceilings ÷ Σ quoted SIU over USDC payments in windows where work was delivered. */
      usdcQuoted: { payments: number; quotedSiu: string; quotedUsdMax: string; usdPerSiuCeiling: string | null };
      fsiuQuoted: { payments: number; quotedSiu: string };
      paymentsInUndeliveredWindows: number;
      paymentsWithoutQuote: number;
    };
  };
  laterWindows: { windowIndex: number; settlements: WindowSummary["settlements"]; bondPaidMinorUnits: string }[];
  forwardDated: number;
  decisionRule: RuleOutcome & { assumption: string };
}

const zeroCounts = (): Counts => ({ usdc: 0, fsiu: 0, split: 0, total: 0 });

function median(values: readonly number[]): string | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  if (s.length % 2 === 1) return String(s[mid]);
  const sum = s[mid - 1] + s[mid];
  return sum % 2 === 0 ? String(sum / 2) : `${(sum - 1) / 2}.5`;
}

function dispersion(values: readonly number[]): Dispersion | null {
  const m = median(values);
  if (m === null) return null;
  return { n: values.length, min: Math.min(...values), median: m, max: Math.max(...values) };
}

function mean(values: readonly number[]): string | null {
  if (values.length === 0) return null;
  return new D(values.reduce((a, b) => a + b, 0)).dividedBy(values.length).toFixed(2);
}

/** Why a run cannot count toward the block, or undefined if it can. */
function exclusionOf(run: RunReport): string | undefined {
  if (run.debugMode?.disqualifiedBecause) return `debug run: ${run.debugMode.disqualifiedBecause}`;
  if (run.abortedBecause !== undefined) return `aborted on a topology precondition: ${run.abortedBecause}`;
  if (run.f1 === undefined) return "report predates the f1 block, so window-1 cleanliness was never recorded";
  if (!run.f1.reached) return "window 1 was not reached";
  return undefined;
}

function countsFor(decisions: readonly { asset: Asset }[]): Counts {
  const c = zeroCounts();
  for (const d of decisions) {
    c[d.asset] += 1;
    c.total += 1;
  }
  return c;
}

function summariseWindow(w: ReportWindow): WindowSummary {
  const allocationByIssuer: WindowSummary["allocationByIssuer"] = {};
  const settlements = { defaulted: 0, expired: 0, outcomeNotRecorded: 0 };
  let bond = new D(0);
  for (const e of w.capacityEvents) {
    if (MINT_KINDS.has(e.kind)) {
      const key = e.issuer ?? "unrecorded";
      const row = (allocationByIssuer[key] ??= { mints: 0, milliSiu: "0" });
      row.mints += 1;
      row.milliSiu = new D(row.milliSiu).plus(e.quantityMilliSiu ?? "0").toFixed(0);
    }
    if (e.kind === "settle_window_close") {
      if (e.settlementOutcome === "Defaulted") settlements.defaulted += 1;
      else if (e.settlementOutcome === "Expired") settlements.expired += 1;
      else settlements.outcomeNotRecorded += 1;
      if (e.bondPaidMinorUnits !== undefined) bond = bond.plus(e.bondPaidMinorUnits);
    }
  }
  return {
    windowIndex: w.windowIndex,
    decisions: countsFor(w.purchases.decisions),
    allocationByIssuer,
    settlements,
    bondPaidMinorUnits: bond.toFixed(0),
  };
}

function summariseRun(run: RunReport): RunSummary {
  const w1 = run.windows.find((w) => w.windowIndex === 1);
  if (w1 === undefined) throw new Error(`${run.runId}: no window 1 in the report`);
  const moments = w1.paymentMoments ?? [];
  const buyers: Record<string, BuyerRun> = {};
  for (const buyer of new Set(w1.purchases.decisions.map((d) => d.buyer))) {
    const mine = w1.purchases.decisions.filter((d) => d.buyer === buyer);
    const assets = new Set(mine.map((d) => d.asset));
    const decisions = countsFor(mine);
    const keyed = (turn: number | undefined) =>
      moments.some((m) => m.agentId === buyer && m.tool === "transfer_claim" && m.turn === turn);
    buyers[buyer] = {
      decisions,
      fsiuShareBp: decisions.total === 0 ? null : Math.floor((decisions.fsiu * 10_000) / decisions.total),
      turns: w1.turnsByAgent[buyer] ?? null,
      settledIn: assets.size === 0 ? "none" : assets.size === 1 ? [...assets][0] : "mixed",
      unkeyedTransfers: w1.capacityEvents.filter(
        (e) => e.kind === "transfer_claim" && e.agentId === buyer && !keyed(e.turn),
      ).length,
    };
  }
  const opportunities = Object.values(run.f1?.opportunities ?? {});
  const eligible = opportunities.some((o) => o.eligible);
  return {
    runId: run.runId,
    windowOne: {
      passed: w1.passed,
      gateDelivered: w1.gateDelivered ?? false,
      ...(w1.incompleteBecause !== undefined ? { incompleteBecause: w1.incompleteBecause } : {}),
    },
    f1Clean: run.f1?.clean === undefined ? "not_computed" : run.f1.clean.clean,
    buyers,
    hops: w1.purchases.journeys.map((j) => j.hops),
    turnsHeld: w1.purchases.journeys.map((j) => j.turnsHeld),
    windows: run.windows.map(summariseWindow),
    forwardDated: run.windows.flatMap((w) => w.capacityEvents).filter((e) => e.forwardDated === true).length,
    opportunity: { eligible, spentOnward: opportunities.some((o) => o.eligible && o.spentOnward) },
  };
}

export function buildBlockReport(reports: readonly RunReport[]): BlockReport {
  const excluded: BlockReport["excluded"] = [];
  const included: RunReport[] = [];
  for (const r of reports) {
    const why = exclusionOf(r);
    if (why === undefined) included.push(r);
    else excluded.push({ runId: r.runId, because: why });
  }
  // After exclusions, so a debug run on another instrument is reported as a debug run and not as
  // the thing that made the block unpoolable.
  const instrument = included.length > 0 ? assertSameInstrument(included) : "none";
  const runs = included.map(summariseRun);

  const buyerNames = [...new Set(runs.flatMap((r) => Object.keys(r.buyers)))].sort();
  const perBuyer: BlockReport["f1"]["perBuyer"] = {};
  for (const b of buyerNames) {
    const mine = runs.flatMap((r) => (r.buyers[b] ? [r.buyers[b]] : []));
    const decisions = zeroCounts();
    for (const m of mine) {
      decisions.usdc += m.decisions.usdc;
      decisions.fsiu += m.decisions.fsiu;
      decisions.split += m.decisions.split;
      decisions.total += m.decisions.total;
    }
    const samples: Record<Asset | "mixed", number[]> = { usdc: [], fsiu: [], split: [], mixed: [] };
    for (const m of mine) if (m.turns !== null && m.settledIn !== "none") samples[m.settledIn].push(m.turns);
    perBuyer[b] = {
      decisions,
      fsiuShareDispersionBp: dispersion(mine.flatMap((m) => (m.fsiuShareBp === null ? [] : [m.fsiuShareBp]))),
      turnsPerPayment: Object.fromEntries(
        (Object.keys(samples) as (Asset | "mixed")[]).map((k) => [
          k,
          { n: samples[k].length, mean: mean(samples[k]), samples: samples[k] },
        ]),
      ) as BlockReport["f1"]["perBuyer"][string]["turnsPerPayment"],
      unkeyedTransfers: mine.reduce((n, m) => n + m.unkeyedTransfers, 0),
    };
  }

  const allHops = runs.flatMap((r) => r.hops);
  const distribution: Record<string, number> = {};
  for (const h of allHops) distribution[String(h)] = (distribution[String(h)] ?? 0) + 1;
  const allHeld = runs.flatMap((r) => r.turnsHeld);

  // Cost: window 1 only, and only where the work was actually delivered.
  let usdcPayments = 0;
  let fsiuPayments = 0;
  let undelivered = 0;
  let withoutQuote = 0;
  let usdcSiu = new D(0);
  let usdcUsd = new D(0);
  let fsiuSiu = new D(0);
  for (const r of included) {
    const w1 = r.windows.find((w) => w.windowIndex === 1) as ReportWindow;
    for (const m of w1.paymentMoments ?? []) {
      if (m.quotedSiu === undefined) {
        withoutQuote += 1;
        continue;
      }
      if (w1.gateDelivered !== true) {
        undelivered += 1;
        continue;
      }
      if (m.asset === "usdc" && m.quotedUsdMax !== undefined) {
        usdcPayments += 1;
        usdcSiu = usdcSiu.plus(m.quotedSiu);
        usdcUsd = usdcUsd.plus(m.quotedUsdMax);
      } else if (m.asset === "fsiu") {
        fsiuPayments += 1;
        fsiuSiu = fsiuSiu.plus(m.quotedSiu);
      }
    }
  }

  const laterIndexes = [...new Set(runs.flatMap((r) => r.windows.map((w) => w.windowIndex)))]
    .filter((i) => i >= 2)
    .sort((a, b) => a - b);
  const laterWindows = laterIndexes.map((windowIndex) => {
    const rows = runs.flatMap((r) => r.windows.filter((w) => w.windowIndex === windowIndex));
    let bond = new D(0);
    const settlements = { defaulted: 0, expired: 0, outcomeNotRecorded: 0 };
    for (const w of rows) {
      settlements.defaulted += w.settlements.defaulted;
      settlements.expired += w.settlements.expired;
      settlements.outcomeNotRecorded += w.settlements.outcomeNotRecorded;
      bond = bond.plus(w.bondPaidMinorUnits);
    }
    return { windowIndex, settlements, bondPaidMinorUnits: bond.toFixed(0) };
  });

  const opportunities: RunOpportunity[] = runs.map((r) => ({ runId: r.runId, ...r.opportunity }));
  const incomplete: Record<string, number> = {};
  for (const r of runs) {
    const why = r.windowOne.incompleteBecause;
    if (why !== undefined) incomplete[why] = (incomplete[why] ?? 0) + 1;
  }

  return {
    instrument,
    caption: BLOCK_CAPTION,
    runs,
    excluded,
    f1: {
      runs: runs.length,
      cleanRuns: runs.filter((r) => r.f1Clean === true).length,
      uncleanRuns: runs.filter((r) => r.f1Clean !== true).map((r) => r.runId),
      windowOne: { passed: runs.filter((r) => r.windowOne.passed).length, incompleteBecause: incomplete },
      perBuyer,
      hops: { distribution, median: median(allHops) },
      turnsHeld: {
        n: allHeld.length,
        median: median(allHeld),
        min: allHeld.length ? Math.min(...allHeld) : null,
        max: allHeld.length ? Math.max(...allHeld) : null,
      },
      cost: {
        usdcQuoted: {
          payments: usdcPayments,
          quotedSiu: usdcSiu.toFixed(),
          quotedUsdMax: usdcUsd.toFixed(),
          usdPerSiuCeiling: usdcSiu.isZero() ? null : usdcUsd.dividedBy(usdcSiu).toFixed(6),
        },
        fsiuQuoted: { payments: fsiuPayments, quotedSiu: fsiuSiu.toFixed() },
        paymentsInUndeliveredWindows: undelivered,
        paymentsWithoutQuote: withoutQuote,
      },
    },
    laterWindows,
    forwardDated: runs.reduce((n, r) => n + r.forwardDated, 0),
    decisionRule: {
      ...decisionRuleVerdict(opportunities),
      assumption:
        "A run counts as eligible if ANY paying agent held fSIU it had been given at the moment it " +
        "paid, and as spending onward if any such agent passed a held claim to a counterparty. " +
        "The rule says 'the agent'; with two payers, this reads it per run. The per-agent " +
        "opportunities are in each run's report (f1.opportunities).",
    },
  };
}

/**
 * Plain text for a terminal. Everything a reader could otherwise miss is stated outright: the
 * caption, every exclusion with its reason, and the decision rule's own reasoning beside its
 * verdict — so a verdict never travels without the sentence that bounds it.
 */
export function renderBlockReport(r: BlockReport): string[] {
  const out: string[] = [];
  out.push(`BLOCK REPORT — instrument ${r.instrument} — ${r.runs.length} run(s) counted`);
  out.push("", r.caption, "");
  for (const e of r.excluded) out.push(`EXCLUDED ${e.runId}: ${e.because}`);
  if (r.excluded.length > 0) out.push("");
  out.push(
    `F1, window 1 only: ${r.f1.cleanRuns}/${r.f1.runs} runs clean` +
      (r.f1.uncleanRuns.length ? ` — NOT clean: ${r.f1.uncleanRuns.join(", ")}` : "") +
      `; window 1 passed in ${r.f1.windowOne.passed}/${r.f1.runs}` +
      (Object.keys(r.f1.windowOne.incompleteBecause).length
        ? ` (did not pass: ${Object.entries(r.f1.windowOne.incompleteBecause).map(([k, v]) => `${k} ×${v}`).join(", ")})`
        : ""),
  );
  for (const [buyer, b] of Object.entries(r.f1.perBuyer)) {
    const d = b.decisions;
    out.push(
      `  ${buyer}: ${d.fsiu} fSIU / ${d.usdc} USDC / ${d.split} split of ${d.total} decisions` +
        (b.fsiuShareDispersionBp
          ? `; fSIU share (bp) min ${b.fsiuShareDispersionBp.min} median ${b.fsiuShareDispersionBp.median} max ${b.fsiuShareDispersionBp.max}`
          : "") +
        `; unkeyed transfers ${b.unkeyedTransfers}`,
    );
    for (const [asset, t] of Object.entries(b.turnsPerPayment)) {
      if (t.n > 0) out.push(`    turns per payment in ${asset}: mean ${t.mean} over ${t.n} window(s) [${t.samples.join(", ")}]`);
    }
  }
  out.push(
    `  hops before redemption: median ${r.f1.hops.median ?? "n/a"} (distribution ${JSON.stringify(r.f1.hops.distribution)})`,
    `  turns held: n ${r.f1.turnsHeld.n}, median ${r.f1.turnsHeld.median ?? "n/a"} (wall-clock is not recorded)`,
    `  cost, QUOTED not paid: USDC ${r.f1.cost.usdcQuoted.quotedUsdMax} ceiling over ${r.f1.cost.usdcQuoted.quotedSiu} SIU` +
      ` = ${r.f1.cost.usdcQuoted.usdPerSiuCeiling ?? "n/a"} USD/SIU; fSIU ${r.f1.cost.fsiuQuoted.quotedSiu} SIU quoted (no dollar cost is stated);` +
      ` ${r.f1.cost.paymentsInUndeliveredWindows} payment(s) in undelivered windows and ${r.f1.cost.paymentsWithoutQuote} without a quote set aside`,
    "",
    "Windows 2 onward — fSIU against an issuer that cannot serve (enforcement, not preference):",
  );
  for (const w of r.laterWindows) {
    out.push(
      `  window ${w.windowIndex}: ${w.settlements.defaulted} Defaulted, ${w.settlements.expired} Expired, ` +
        `${w.settlements.outcomeNotRecorded} outcome NOT recorded; bond paid ${w.bondPaidMinorUnits} USDC minor units`,
    );
  }
  out.push(
    "",
    `forward-dated claims: ${r.forwardDated}`,
    `DECISION RULE: ${r.decisionRule.verdict} (${r.decisionRule.spentOnward} of ${r.decisionRule.eligible} eligible runs spent onward; ${r.decisionRule.runs} runs)`,
    `  ${r.decisionRule.reason}`,
    `  Reading: ${r.decisionRule.assumption}`,
  );
  return out;
}
