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
 * **Cost is what was SETTLED.** USDC is priced at the amount the seller actually settled, joined to
 * the payment by the quote's request id, never at the quote's ceiling. fSIU is given a dollar
 * figure too — what the claim cost to mint, read from the mint receipt — with its print-equivalent
 * beside it (`cost-metric.ts`). A payment whose settlement or claim cannot be found is counted as
 * unmatched, never priced at zero.
 *
 * Nothing is read from a chain. Everything below comes from fields the runs recorded, and where a
 * field is missing the report says so (`outcomeNotRecorded`, `paymentsWithoutQuote`) instead of
 * filling it in.
 */
import { D } from "@touchstone/sdk";
import { costOfRuns, type BlockCost } from "./cost-metric.js";
import { decisionRuleVerdict, type RuleOutcome, type RunOpportunity } from "./decision-rule.js";
import type { F1Report, SellerFeeAsymmetry } from "./instrument-report.js";
import { assertSameInstrument } from "./instrument.js";

/**
 * Fixed text, 2026-10-05. Scoped to window 1 (plan F8): "always redeemable within its window" is
 * false in windows 2 and 3, where the single issuer is non-serving by design. It also states that
 * every issuer is Touchstone's own account and that lot sizes are scenario parameters, so nothing
 * here can be read as a measurement of real issuers.
 */
export const BLOCK_CAPTION =
  "Single issuer per window. In window 1, where F1 is measured, every fSIU is backed by one " +
  "serving issuer, so claims are fully fungible and redeemable within the window — the best case " +
  "for fSIU, with no cross-issuer credit risk. Windows 2 and 3 exercise enforcement against an " +
  "issuer that cannot serve, representing one that measured well at bonding and failed " +
  "afterwards. All issuers are Touchstone's own API accounts, and lot sizes are scenario " +
  "parameters, not measured issuance. Cross-issuer fungibility and routing are not tested.";

type Asset = "usdc" | "fsiu" | "split";
const MINT_KINDS: ReadonlySet<string> = new Set(["mint_claim", "pay_with_claim", "settle_split"]);

export interface ReportEvent {
  kind: string;
  agentId?: string;
  turn?: number;
  issuer?: string;
  tokenId?: string;
  mintCostMinorUnits?: string;
  settlesRequestId?: string;
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
  /** What each USDC quote was actually settled for, keyed by the quote's request id. */
  usdcSettlements?: { requestId: string; settledMinorUnits: string; quotedMinorUnits: string }[];
  capacityEvents: ReportEvent[];
  turnsByAgent: Record<string, number>;
}
export interface RunReport {
  runId: string;
  instrument?: { id: string };
  debugMode?: { disqualifiedBecause?: string | null };
  abortedBecause?: string;
  /** The print the run used, decimal USD per SIU. */
  rateUsdPerSiu?: string;
  /** The escrow fee the dollar route charges the seller, as the run read it from the chain. */
  sellerFeeAsymmetry?: SellerFeeAsymmetry;
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

/**
 * How a buyer paid, by ROUTE rather than by asset. A mint-and-forward payment (`pay_with_claim`) is
 * USDC leaving the payer and a freshly minted claim reaching the seller — it is not the payer
 * spending fSIU it holds — so counting it as "paid in fSIU" would make F1 measure the delivery
 * format and not whether agents use fSIU as money. Three routes, with the headline being the first:
 *   - heldBalance:    a transfer naming a quote, out of a balance the payer holds;
 *   - mintAndForward: a claim minted and sent to the seller in one call;
 *   - usdc:           escrow.
 * A split is both a mint-and-forward claim leg and a dollar leg in one call, so it keeps its own
 * count rather than being split across the other two.
 */
export interface RouteCounts {
  heldBalance: number;
  mintAndForward: number;
  usdc: number;
  split: number;
  total: number;
  /** Of `heldBalance`: payments made while holding fSIU received from another agent. The rest were
   *  paid from claims the payer minted for itself first, which is mint-and-forward in two steps. */
  heldBalanceWhileHoldingReceived: number;
}

export interface BuyerRun {
  decisions: Counts;
  routes: RouteCounts;
  /** THE F1 HEADLINE: the share of this buyer's window-1 payments made from a held fSIU balance,
   *  in basis points, rounded down. */
  heldBalanceShareBp: number | null;
  /** Beside it: held-balance plus mint-and-forward — fSIU by any route. Never the headline. */
  fsiuAnyRouteShareBp: number | null;
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
  opportunity: { eligible: boolean; spentOnward: boolean; paidInFsiuWhileHoldingReceived: boolean };
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
        routes: RouteCounts;
        /** The headline, across runs. */
        heldBalanceShareDispersionBp: Dispersion | null;
        fsiuAnyRouteShareDispersionBp: Dispersion | null;
        turnsPerPayment: Record<Asset | "mixed", { n: number; mean: string | null; samples: number[] }>;
        unkeyedTransfers: number;
      }
    >;
    hops: { distribution: Record<string, number>; median: string | null };
    turnsHeld: { n: number; median: string | null; min: number | null; max: number | null };
    cost: BlockCost;
  };
  laterWindows: { windowIndex: number; settlements: WindowSummary["settlements"]; bondPaidMinorUnits: string }[];
  forwardDated: number;
  /** Recorded either way. A run that did not record it is "not recorded", never zero. */
  sellerFeeAsymmetry: SellerFeeAsymmetry | "not recorded" | "mixed across runs";
  decisionRule: RuleOutcome & {
    assumption: string;
    /** The same rule under the LOOSER reading — paid in fSIU by any route while holding received
     *  fSIU — beside the balance-level one, so a difference is visible and never substituted. */
    looserReading: RuleOutcome;
  };
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
  if (run.f1.countingErrors === undefined) {
    return "f1 block predates the counting check and the balance-level decision rule";
  }
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

function routeCountsOf(moments: readonly ReportMoment[]): RouteCounts {
  const c: RouteCounts = {
    heldBalance: 0,
    mintAndForward: 0,
    usdc: 0,
    split: 0,
    total: 0,
    heldBalanceWhileHoldingReceived: 0,
  };
  for (const m of moments) {
    if (m.tool === "pay") c.usdc += 1;
    else if (m.tool === "pay_with_claim") c.mintAndForward += 1;
    else if (m.tool === "settle_split") c.split += 1;
    // Only a transfer that NAMED a quote is a payment; one that named none settled nothing and is
    // counted as an unkeyed transfer instead.
    else if (m.tool === "transfer_claim" && m.requestId !== undefined) {
      c.heldBalance += 1;
      if (BigInt(m.heldReceivedMilliSiu) > 0n) c.heldBalanceWhileHoldingReceived += 1;
    } else continue;
    c.total += 1;
  }
  return c;
}

const shareBp = (part: number, whole: number): number | null =>
  whole === 0 ? null : Math.floor((part * 10_000) / whole);

function summariseRun(run: RunReport): RunSummary {
  const w1 = run.windows.find((w) => w.windowIndex === 1);
  if (w1 === undefined) throw new Error(`${run.runId}: no window 1 in the report`);
  const moments = w1.paymentMoments ?? [];
  const buyers: Record<string, BuyerRun> = {};
  const buyerNames = new Set([
    ...w1.purchases.decisions.map((d) => d.buyer),
    ...moments.map((m) => m.agentId),
  ]);
  for (const buyer of buyerNames) {
    const mine = w1.purchases.decisions.filter((d) => d.buyer === buyer);
    const assets = new Set(mine.map((d) => d.asset));
    const decisions = countsFor(mine);
    const routes = routeCountsOf(moments.filter((m) => m.agentId === buyer));
    buyers[buyer] = {
      decisions,
      routes,
      heldBalanceShareBp: shareBp(routes.heldBalance, routes.total),
      fsiuAnyRouteShareBp: shareBp(routes.heldBalance + routes.mintAndForward, routes.total),
      turns: w1.turnsByAgent[buyer] ?? null,
      settledIn: assets.size === 0 ? "none" : assets.size === 1 ? [...assets][0] : "mixed",
      // A transfer is unkeyed when its capacity event names no quote. (Payment moments cannot say:
      // one is recorded for every transfer_claim, keyed or not.)
      unkeyedTransfers: w1.capacityEvents.filter(
        (e) => e.kind === "transfer_claim" && e.agentId === buyer && e.settlesRequestId === undefined,
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
    opportunity: {
      eligible,
      spentOnward: opportunities.some((o) => o.eligible && o.spentOnward),
      paidInFsiuWhileHoldingReceived: opportunities.some((o) => o.paidInFsiuWhileHoldingReceived),
    },
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
  // A miscount is not a result and is not silently set aside: the rule would be decided on nothing.
  for (const r of included) {
    const errors = r.f1?.countingErrors ?? [];
    if (errors.length > 0) {
      throw new Error(
        `${r.runId}: counting error — ${errors.join("; ")}. The decision rule is not computed from a ` +
          "run whose eligibility count is wrong.",
      );
    }
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
      routes: mine.reduce<RouteCounts>(
        (sum, m) => ({
          heldBalance: sum.heldBalance + m.routes.heldBalance,
          mintAndForward: sum.mintAndForward + m.routes.mintAndForward,
          usdc: sum.usdc + m.routes.usdc,
          split: sum.split + m.routes.split,
          total: sum.total + m.routes.total,
          heldBalanceWhileHoldingReceived: sum.heldBalanceWhileHoldingReceived + m.routes.heldBalanceWhileHoldingReceived,
        }),
        { heldBalance: 0, mintAndForward: 0, usdc: 0, split: 0, total: 0, heldBalanceWhileHoldingReceived: 0 },
      ),
      heldBalanceShareDispersionBp: dispersion(mine.flatMap((m) => (m.heldBalanceShareBp === null ? [] : [m.heldBalanceShareBp]))),
      fsiuAnyRouteShareDispersionBp: dispersion(mine.flatMap((m) => (m.fsiuAnyRouteShareBp === null ? [] : [m.fsiuAnyRouteShareBp]))),
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

  // Cost: window 1 only, delivered work only, from what was settled (cost-metric.ts).
  const cost = costOfRuns(
    included.map((r) => {
      const w1 = r.windows.find((w) => w.windowIndex === 1) as ReportWindow;
      if (r.rateUsdPerSiu === undefined) throw new Error(`${r.runId}: the report states no print rate.`);
      return {
        gateDelivered: w1.gateDelivered,
        paymentMoments: w1.paymentMoments,
        usdcSettlements: w1.usdcSettlements,
        capacityEvents: w1.capacityEvents,
        printRateUsdPerSiu: r.rateUsdPerSiu,
      };
    }),
  );

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

  const opportunities: RunOpportunity[] = runs.map((r) => ({
    runId: r.runId,
    eligible: r.opportunity.eligible,
    spentOnward: r.opportunity.spentOnward,
  }));
  const looserOpportunities: RunOpportunity[] = runs.map((r) => ({
    runId: r.runId,
    eligible: r.opportunity.eligible,
    spentOnward: r.opportunity.paidInFsiuWhileHoldingReceived,
  }));
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
      cost,
    },
    laterWindows,
    forwardDated: runs.reduce((n, r) => n + r.forwardDated, 0),
    sellerFeeAsymmetry: (() => {
      const recorded = included.map((r) => r.sellerFeeAsymmetry);
      if (recorded.length === 0 || recorded.some((f) => f === undefined)) return "not recorded" as const;
      const first = JSON.stringify(recorded[0]);
      return recorded.every((f) => JSON.stringify(f) === first)
        ? (recorded[0] as SellerFeeAsymmetry)
        : ("mixed across runs" as const);
    })(),
    decisionRule: {
      ...decisionRuleVerdict(opportunities),
      assumption:
        "Held fSIU means fSIU received as payment from another agent, never an opening balance or " +
        "operator grant. Onward spending is read at the balance level: a transfer naming a quote " +
        "left the agent's balance while it held received fSIU it had not all redeemed. A payment " +
        "made by minting a new claim and forwarding it does not touch the balance and is not " +
        "counted; the looser reading that does count it is reported beside this one. The rule " +
        "says 'the agent'; with two payers, a run counts if ANY paying agent qualifies. " +
        "Per-agent opportunities are in each run's report (f1.opportunities).",
      looserReading: decisionRuleVerdict(looserOpportunities),
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
    const k = b.routes;
    const bp = (d: { min: number; median: string; max: number } | null): string =>
      d ? `min ${d.min} median ${d.median} max ${d.max} bp` : "n/a";
    out.push(
      `  ${buyer}: HEADLINE — paid from a held fSIU balance: ${k.heldBalance} of ${k.total} payments ` +
        `(share across runs: ${bp(b.heldBalanceShareDispersionBp)})`,
      `    beside it: ${k.mintAndForward} mint-and-forward (USDC out, a new claim to the seller), ` +
        `${k.usdc} USDC, ${k.split} split; fSIU by any route ${bp(b.fsiuAnyRouteShareDispersionBp)}; ` +
        `${k.heldBalanceWhileHoldingReceived} of the held-balance payments were made while holding fSIU received from another agent; ` +
        `unkeyed transfers ${b.unkeyedTransfers}`,
    );
    for (const [asset, t] of Object.entries(b.turnsPerPayment)) {
      if (t.n > 0) out.push(`    turns per payment in ${asset}: mean ${t.mean} over ${t.n} window(s) [${t.samples.join(", ")}]`);
    }
  }
  out.push(
    `  hops before redemption: median ${r.f1.hops.median ?? "n/a"} (distribution ${JSON.stringify(r.f1.hops.distribution)})`,
    `  turns held: n ${r.f1.turnsHeld.n}, median ${r.f1.turnsHeld.median ?? "n/a"} (wall-clock is not recorded)`,
    `  cost per delivered SIU, from what was SETTLED (window 1, delivered work):`,
    `    USDC:  ${r.f1.cost.usdc.payments} payment(s), $${r.f1.cost.usdc.usd} over ${r.f1.cost.usdc.quotedSiu} SIU = ` +
      `${r.f1.cost.usdc.usdPerSiu ?? "n/a"} USD/SIU; ${r.f1.cost.usdc.settledBelowQuoted} settled below the quote's ceiling, ` +
      `${r.f1.cost.usdc.escrowNeverSettled} escrow(s) never settled (not priced)`,
    `    fSIU:  ${r.f1.cost.fsiu.payments} payment(s), $${r.f1.cost.fsiu.usd} to mint over ${r.f1.cost.fsiu.quotedSiu} SIU = ` +
      `${r.f1.cost.fsiu.usdPerSiu ?? "n/a"} USD/SIU; print-equivalent $${r.f1.cost.fsiu.printEquivalentUsd} = ` +
      `${r.f1.cost.fsiu.printEquivalentUsdPerSiu ?? "n/a"} USD/SIU; ${r.f1.cost.fsiu.carriedAtOriginalMintCost} passed on and carried at original mint cost`,
    `    split: ${r.f1.cost.split.payments} payment(s), $${r.f1.cost.split.usd} over ${r.f1.cost.split.quotedSiu} SIU`,
    `    set aside: ${r.f1.cost.paymentsInUndeliveredWindows} in undelivered windows, ${r.f1.cost.paymentsWithoutQuote} without a quote, ` +
      `${r.f1.cost.unmatched} UNMATCHED (claim or settlement not found in the record — not priced as free)`,
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
    typeof r.sellerFeeAsymmetry === "string"
      ? `seller-side fee: ${r.sellerFeeAsymmetry === "not recorded" ? "NOT recorded" : "MIXED across runs"} — the dollar route's escrow fee on sellers is not stated for this block`
      : `seller-side fee: the dollar route charges the seller ${r.sellerFeeAsymmetry.usdcRouteEscrowFeeBps} bps; the fSIU route charges ${r.sellerFeeAsymmetry.fsiuRouteFeeBps}. ` +
        "Not a buyer's cost, and sellers cannot steer which asset a quote is settled in.",
    `DECISION RULE: ${r.decisionRule.verdict} (${r.decisionRule.spentOnward} of ${r.decisionRule.eligible} eligible runs spent onward; ${r.decisionRule.runs} runs)`,
    `  ${r.decisionRule.reason}`,
    `  Reading: ${r.decisionRule.assumption}`,
    `  Looser reading (paid in fSIU by ANY route while holding received fSIU): ${r.decisionRule.looserReading.verdict} ` +
      `(${r.decisionRule.looserReading.spentOnward} of ${r.decisionRule.looserReading.eligible} eligible runs)` +
      (r.decisionRule.looserReading.verdict !== r.decisionRule.verdict
        ? " — DIFFERS from the balance-level verdict above; the difference is payments made by minting and forwarding a new claim"
        : ""),
  );
  return out;
}
