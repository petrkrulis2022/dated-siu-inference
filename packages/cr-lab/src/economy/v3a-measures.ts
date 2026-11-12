/**
 * v3a's measures, thresholds and kill rule (docs/experiment-3a-design.md, "Measures, thresholds and kill criteria"; thresholds approved 11 Nov 2026, D142). Each function of
 * money gets its own share-based measure, scored per currency and pooled across the runs of each arm. An n/a never counts as a kill signal or as a pass.
 *
 *  - Exchange: AGU-lab's share of payments by value, counting only payments where the payer could pay in both currencies and the payee accepted both; forced and code
 *    payments never count (D143). Signal >= 30%; kill < 10%.
 *  - Account: the unit used in reasoning, coded blind (`v3a-coding.ts`), over every priced decision; n/a if the two coders' kappa is below 0.7. Signal: SIU in >= 40%
 *    of decisions; kill: SIU in < 20% AND binding quotes in mSIU < 10%.
 *  - Store of value: each agent's share of wealth in AGU-lab and fSIU at each close, valued at the print. Signal: median >= 40% at window 8 (start 50%); kill: median
 *    < 15% at window 8 in the low-volatility setting.
 *  - Deferred payment: forward commitments' share in each currency, and missed worthwhile purchases (`World.logOpportunities` computes "worthwhile" in advance from what
 *    the agent could see). Signal: missed <= 50%; kill: missed >= 80% with at least 20 worthwhile opportunities; under 20, n/a.
 *  - Comparability: the share of choices that take the cheapest offer per accepted mSIU, SIU-first display versus dollars-first, over decisions with two or more offers.
 *    Signal: SIU-first beats dollars-first by >= 10 points; kill: no difference with at least 40 decisions per display.
 *  - Arm B adds: the share of the reserve spent on work, the share unwound within one round of a close, and attempts to meet the rule with claims that hold no work value
 *    for its horizon.
 *  - Kill rule: any two kill signals in arm A close the AGU-lab question for this design.
 *
 * Window numbers come from the engine's own entries (each window's `price` entry, `atClose`, `forWindow`), never from the order day labels first appear in: genesis is
 * logged on its own day (window 0), and counting that day as window 1 is an off-by-one the v1/v2 scorer has (`scoring.ts`'s `windowIndexOf`; reported in Phase 3).
 */
import { siuFirstForWindow } from "./board.js";
import { asBigInt, type LogEntry } from "./log.js";
import type { EconomyParams } from "./params.js";
import { extractPricedDecisions, kappa, KAPPA_FLOOR, type UnitLabel } from "./v3a-coding.js";
import type { Arm } from "./v3a-market.js";

export interface V3aRunLog {
  label: string;
  log: readonly LogEntry[];
}
export interface RunMeta {
  arm: Arm;
  volatility: "low" | "high";
  seed: string;
  priceSeedHash: string;
  cell?: string;
}

/** a run's own identity, read from its genesis entry (the D133 rule: the scorer reads the seed from the log, never from a config default) */
export function runMeta(log: readonly LogEntry[]): RunMeta | undefined {
  const g = log.find((e) => e.kind === "genesis");
  const v = g?.v3a as { arm?: Arm; volatility?: "low" | "high"; priceSeedHash?: string; cell?: string } | undefined;
  if (g === undefined || v?.arm === undefined || v.volatility === undefined || typeof g.seed !== "string") return undefined;
  return { arm: v.arm, volatility: v.volatility, seed: g.seed, priceSeedHash: String(v.priceSeedHash), ...(v.cell !== undefined ? { cell: v.cell } : {}) };
}

/** each day label's engine window: 0 for genesis's day, k for the day window k's print was published on */
export function engineWindows(log: readonly LogEntry[]): Map<string, number> {
  const m = new Map<string, number>();
  const g = log.find((e) => e.kind === "genesis");
  if (g !== undefined) m.set(g.window, 0);
  for (const e of log) if (e.kind === "price" && typeof e.atWindow === "number") m.set(e.window, e.atWindow);
  return m;
}

export type Verdict = "signal" | "kill" | "neither" | "n/a";
const big = (v: unknown): bigint => asBigInt(v) ?? 0n;
const share = (num: bigint, den: bigint): number | null => (den === 0n ? null : Number((num * 1_000_000n) / den) / 1_000_000);
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// ---- exchange --------------------------------------------------------------------------------------------------------------------------------------
export interface Exchange {
  payments: number;
  byCurrencyMicroSiu: { agu: bigint; usdc: bigint };
  aguShare: number | null;
  /** D144: briefs paid in work claims, left out of the denominator (the claims' purchase was already counted as a payment in USDC or AGU-lab); reported under deferred payment */
  claimPaymentsLeftOut: number;
  excluded: { forced: number; scripted: number; payerCouldNotPayBoth: number; payeeDidNotAcceptBoth: number };
  verdict: Verdict;
}
export function scoreExchange(runs: readonly V3aRunLog[], min: number): Exchange {
  const by = { agu: 0n, usdc: 0n };
  const excluded = { forced: 0, scripted: 0, payerCouldNotPayBoth: 0, payeeDidNotAcceptBoth: 0 };
  let n = 0;
  let claimPayments = 0;
  for (const r of runs)
    for (const e of r.log) {
      if (e.kind !== "payment") continue;
      if (e.currency === "claims") claimPayments++;
      else if (e.forced === true) excluded.forced++;
      else if (e.scripted === true) excluded.scripted++;
      else if (e.couldPayBoth !== true) excluded.payerCouldNotPayBoth++;
      else if (e.payeeAcceptsBoth !== true) excluded.payeeDidNotAcceptBoth++;
      else {
        n++;
        by[e.currency as "agu" | "usdc"] += big(e.valueMicroSiu);
      }
    }
  const aguShare = share(by.agu, by.agu + by.usdc);
  return {
    payments: n,
    byCurrencyMicroSiu: by,
    aguShare,
    claimPaymentsLeftOut: claimPayments,
    excluded,
    verdict: n < min || aguShare === null ? "n/a" : aguShare >= 0.3 ? "signal" : aguShare < 0.1 ? "kill" : "neither",
  };
}

// ---- account ---------------------------------------------------------------------------------------------------------------------------------------
export interface Codings {
  a: ReadonlyMap<string, UnitLabel>;
  b: ReadonlyMap<string, UnitLabel>;
  hand?: ReadonlyMap<string, UnitLabel>;
}
export interface Account {
  decisions: number;
  kappa: number | null;
  /** decisions both coders gave the same label: the only ones scored */
  agreed: number;
  byLabel: Record<UnitLabel, number>;
  siuShare: number | null;
  /** SIU or both, reported beside the scored (SIU only) share */
  siuOrBothShare: number | null;
  bindingQuotes: { msiu: number; usd: number; msiuShare: number | null };
  hand?: { vsA: number | null; vsB: number | null; n: number };
  verdict: Verdict;
  reason?: string;
}
export function scoreAccount(runs: readonly V3aRunLog[], codings: Codings | undefined, min: number): Account {
  const decisions = runs.flatMap((r) => extractPricedDecisions(r.label, r.log));
  const quotes = runs.flatMap((r) => r.log.filter((e) => e.kind === "quote"));
  const msiu = quotes.filter((q) => q.priceUnit !== "usdc").length;
  const bindingQuotes = { msiu, usd: quotes.length - msiu, msiuShare: quotes.length === 0 ? null : msiu / quotes.length };
  const byLabel: Record<UnitLabel, number> = { SIU: 0, dollars: 0, both: 0, none: 0 };
  const base = { decisions: decisions.length, byLabel, bindingQuotes };
  if (codings === undefined)
    return { ...base, kappa: null, agreed: 0, siuShare: null, siuOrBothShare: null, verdict: "n/a", reason: "not coded yet" };
  const keys = new Set(decisions.map((d) => d.key));
  const restrict = (m: ReadonlyMap<string, UnitLabel>) => new Map([...m].filter(([k]) => keys.has(k)));
  const a = restrict(codings.a);
  const b = restrict(codings.b);
  const k = kappa(a, b);
  let agreed = 0;
  for (const [key, la] of a)
    if (b.get(key) === la) {
      agreed++;
      byLabel[la]++;
    }
  const hand =
    codings.hand !== undefined
      ? { vsA: kappa(restrict(codings.hand), a).kappa, vsB: kappa(restrict(codings.hand), b).kappa, n: restrict(codings.hand).size }
      : undefined;
  const siuShare = agreed === 0 ? null : byLabel.SIU / agreed;
  const siuOrBothShare = agreed === 0 ? null : (byLabel.SIU + byLabel.both) / agreed;
  const out = { ...base, kappa: k.kappa, agreed, siuShare, siuOrBothShare, ...(hand !== undefined ? { hand } : {}) };
  if (k.kappa === null || k.kappa < KAPPA_FLOOR)
    return { ...out, verdict: "n/a", reason: `the coders' kappa is ${k.kappa === null ? "undefined" : k.kappa.toFixed(3)}, below ${KAPPA_FLOOR}` };
  if (agreed < min || siuShare === null) return { ...out, verdict: "n/a", reason: `${agreed} agreed decisions, fewer than ${min}` };
  const kill = siuShare < 0.2 && bindingQuotes.msiuShare !== null && bindingQuotes.msiuShare < 0.1;
  return { ...out, verdict: siuShare >= 0.4 ? "signal" : kill ? "kill" : "neither" };
}

// ---- store of value --------------------------------------------------------------------------------------------------------------------------------
export interface StoreOfValue {
  /** the median work share (AGU-lab and fSIU) across every model agent of every run, at each close */
  medianByClose: { close: number; median: number | null; n: number }[];
  finalMedian: number | null;
  finalN: number;
  /** the kill is judged in the low-volatility runs only */
  lowVolFinalMedian: number | null;
  lowVolFinalN: number;
  /**
   * D144: the same shares with AGU-lab valued at NAV WITH the buffer, reported beside the verdict. The verdict uses the reserve NAV every price, creation and redemption
   * uses; the buffer pays the roll's cost of unsold front work, so NAV with the buffer is where that carrying cost shows as it drains.
   */
  withBuffer: { medianByClose: { close: number; median: number | null; n: number }[]; finalMedian: number | null; lowVolFinalMedian: number | null };
  verdict: Verdict;
}
export function scoreStoreOfValue(runs: readonly V3aRunLog[], finalClose: number, min: number): StoreOfValue {
  const at = (close: number, rs: readonly V3aRunLog[], field = "workShareBps"): number[] =>
    rs.flatMap((r) =>
      r.log
        .filter((e) => e.kind === "holdings" && e.atClose === close && e[field] !== null && e[field] !== undefined)
        .map((e) => Number(big(e[field])) / 10_000),
    );
  const medianByClose = Array.from({ length: finalClose + 1 }, (_, close) => {
    const xs = at(close, runs);
    return { close, median: median(xs), n: xs.length };
  });
  const final = at(finalClose, runs);
  const low = at(
    finalClose,
    runs.filter((r) => runMeta(r.log)?.volatility === "low"),
  );
  const finalMedian = median(final);
  const lowMedian = median(low);
  const kill = low.length >= min && lowMedian !== null && lowMedian < 0.15;
  const lowRuns = runs.filter((r) => runMeta(r.log)?.volatility === "low");
  const withBuffer = {
    medianByClose: Array.from({ length: finalClose + 1 }, (_, close) => {
      const xs = at(close, runs, "workShareBpsWithBuffer");
      return { close, median: median(xs), n: xs.length };
    }),
    finalMedian: median(at(finalClose, runs, "workShareBpsWithBuffer")),
    lowVolFinalMedian: median(at(finalClose, lowRuns, "workShareBpsWithBuffer")),
  };
  return {
    withBuffer,
    medianByClose,
    finalMedian,
    finalN: final.length,
    lowVolFinalMedian: lowMedian,
    lowVolFinalN: low.length,
    verdict: final.length < min || finalMedian === null ? "n/a" : finalMedian >= 0.4 ? "signal" : kill ? "kill" : "neither",
  };
}

// ---- deferred payment ------------------------------------------------------------------------------------------------------------------------------
export interface DeferredPayment {
  forwardByCurrencyMicroSiu: { agu: bigint; usdc: bigint; claims: bigint };
  /** D144: briefs paid in work claims (the claims were bought earlier, a payment already counted in its own currency): reported here, never in exchange */
  claimTransfers: { count: number; valueMicroSiu: bigint };
  forwardShares: { agu: number | null; usdc: number | null };
  worthwhile: number;
  missed: number;
  missedShare: number | null;
  verdict: Verdict;
}
export function scoreDeferredPayment(runs: readonly V3aRunLog[], min: number): DeferredPayment {
  const fwd = { agu: 0n, usdc: 0n, claims: 0n };
  const claimTransfers = { count: 0, valueMicroSiu: 0n };
  let worthwhile = 0;
  let missed = 0;
  for (const r of runs) {
    const win = engineWindows(r.log);
    for (const e of r.log)
      if (e.kind === "payment" && e.forced !== true && e.scripted !== true) {
        if (e.currency === "claims") {
          claimTransfers.count++;
          claimTransfers.valueMicroSiu += big(e.valueMicroSiu);
          continue;
        }
        const now = win.get(e.window) ?? 0;
        const forward = e.what === "front claims" || (e.what === "claims" && Number(e.forWindow) > now);
        if (forward) fwd[e.currency as "agu" | "usdc" | "claims"] += big(e.valueMicroSiu);
      }
    // an opportunity is one (agent, window, task); worthwhile if it was at any round before its window; missed if the agent never bought that work ahead
    const opp = new Map<string, boolean>();
    for (const e of r.log)
      if (e.kind === "opportunity") {
        const key = `${e.actor}|${e.forWindow}|${e.task}`;
        opp.set(key, (opp.get(key) ?? false) || e.worthwhile === true);
      }
    const covered = new Set<string>();
    for (const e of r.log) {
      const now = win.get(e.window) ?? 0;
      if (e.kind === "claim-mint" && Number(e.forWindow) > now) covered.add(`${e.actor}|${e.forWindow}|${e.task}`);
      if (e.kind === "message" && typeof e.text === "string") {
        const m = /^front-claim order: [\d.]+ SIU of (\S+) for the next window$/.exec(e.text);
        if (m !== null) covered.add(`${e.actor}|${now + 1}|${m[1]}`);
      }
    }
    for (const [key, w] of opp)
      if (w) {
        worthwhile++;
        if (!covered.has(key)) missed++;
      }
  }
  const missedShare = worthwhile === 0 ? null : missed / worthwhile;
  const total = fwd.agu + fwd.usdc;
  return {
    forwardByCurrencyMicroSiu: fwd,
    claimTransfers,
    forwardShares: { agu: share(fwd.agu, total), usdc: share(fwd.usdc, total) },
    worthwhile,
    missed,
    missedShare,
    verdict: worthwhile < min || missedShare === null ? "n/a" : missedShare <= 0.5 ? "signal" : missedShare >= 0.8 ? "kill" : "neither",
  };
}

// ---- comparability ---------------------------------------------------------------------------------------------------------------------------------
export interface Comparability {
  siuFirst: { decisions: number; cheapest: number; share: number | null };
  dollarsFirst: { decisions: number; cheapest: number; share: number | null };
  byKind: Record<"brief" | "commission" | "claims", number>;
  /** SIU-first share minus dollars-first share, in points */
  differencePoints: number | null;
  verdict: Verdict;
}
/**
 * `passBps` (issuer -> task -> pass rate) turns a commission's list price into its cost per ACCEPTED task when failed work is paid for; when it is refunded (the design's
 * rule and the default), a failed task costs nothing, so the cost per accepted task is the list price itself.
 */
export function scoreComparability(
  runs: readonly V3aRunLog[],
  passBps: Readonly<Record<string, Partial<Record<string, number>>>>,
  failedWorkPays: boolean,
  minSignal: number,
  minKill: number,
): Comparability {
  const sides = { siu: { decisions: 0, cheapest: 0 }, usd: { decisions: 0, cheapest: 0 } };
  const byKind = { brief: 0, commission: 0, claims: 0 };
  const count = (window: number, tookCheapest: boolean, kind: keyof typeof byKind): void => {
    const s = siuFirstForWindow(window) ? sides.siu : sides.usd;
    s.decisions++;
    if (tookCheapest) s.cheapest++;
    byKind[kind]++;
  };
  for (const r of runs) {
    const win = engineWindows(r.log);
    const quotes = r.log.filter((e) => e.kind === "quote");
    const seen = new Set<string>();
    for (const e of r.log) {
      const k = win.get(e.window) ?? 0;
      // a brief: an acceptance (escrow or the first claim paid) where two or more quotes for the need were posted before it; the same need's work for all, so cheapest is lowest price
      if ((e.kind === "escrow-open" || e.kind === "claim-transfer") && typeof e.quote === "string" && !seen.has(e.quote)) {
        seen.add(e.quote);
        const q = quotes.find((x) => x.quote === e.quote);
        const alts = quotes.filter((x) => x.need === q?.need && x.seq < e.seq);
        if (q !== undefined && alts.length >= 2)
          count(k, big(q.priceMicroSiu) <= alts.reduce((m, x) => (big(x.priceMicroSiu) < m ? big(x.priceMicroSiu) : m), big(alts[0]?.priceMicroSiu)), "brief");
      }
      // a commission: every issuer of the task was on offer; cheapest per accepted task
      if (e.kind === "escrow-open" && typeof e.alternatives === "object" && e.alternatives !== null && typeof e.task === "string") {
        const alts = Object.entries(e.alternatives as Record<string, unknown>);
        if (alts.length >= 2) {
          const cost = (issuer: string, price: bigint): number =>
            failedWorkPays ? Number(price) / ((passBps[issuer]?.[e.task as string] ?? 10_000) / 10_000) : Number(price);
          const best = Math.min(...alts.map(([i, p]) => cost(i, big(p))));
          const chosen = alts.find(([i]) => i === e.to);
          if (chosen !== undefined) count(k, cost(chosen[0], big(chosen[1])) <= best, "commission");
        }
      }
      // claims from PROVIDER: the offers the buyer could see for that class and window; for one grade, the deepest discount is the cheapest per mSIU
      if (e.kind === "claim-mint" && Array.isArray(e.alternatives) && e.alternatives.length >= 2) {
        const alts = e.alternatives as { offer: string; discountBps: unknown }[];
        const deepest = alts.reduce((m, x) => (big(x.discountBps) > m ? big(x.discountBps) : m), big(alts[0]?.discountBps));
        const mine = alts.find((x) => x.offer === e.offer);
        if (mine !== undefined) count(k, big(mine.discountBps) >= deepest, "claims");
      }
    }
  }
  const sh = (s: { decisions: number; cheapest: number }) => (s.decisions === 0 ? null : s.cheapest / s.decisions);
  const siuShare = sh(sides.siu);
  const usdShare = sh(sides.usd);
  const diff = siuShare === null || usdShare === null ? null : (siuShare - usdShare) * 100;
  const enough = (n: number) => sides.siu.decisions >= n && sides.usd.decisions >= n;
  return {
    siuFirst: { ...sides.siu, share: siuShare },
    dollarsFirst: { ...sides.usd, share: usdShare },
    byKind,
    differencePoints: diff,
    verdict:
      diff === null || !enough(minSignal) ? "n/a" : diff >= 10 ? "signal" : enough(minKill) && diff <= 0 ? "kill" : "neither",
  };
}

// ---- arm B -----------------------------------------------------------------------------------------------------------------------------------------
export interface ArmBExtras {
  checks: number;
  compliant: number;
  /** of the reserve held at each check, the share spent on work in the window after it */
  spentOnWorkShare: number | null;
  /** of the reserve held at each check, the share sold back for USDC in the first round after it */
  unwoundShare: number | null;
  /** checks at which the agent held claims outside the rule's horizon (instruments that hold no work value for it) */
  attemptsOutsideHorizon: number;
}
export function scoreArmB(runs: readonly V3aRunLog[]): ArmBExtras {
  let checks = 0;
  let compliant = 0;
  let reserve = 0n;
  let spent = 0n;
  let unwound = 0n;
  let outside = 0;
  for (const r of runs) {
    const win = engineWindows(r.log);
    const printAt = new Map<number, bigint>();
    for (const e of r.log) if (e.kind === "price") printAt.set(Number(e.atWindow), big(e.commodity));
    for (const c of r.log.filter((e) => e.kind === "rule-check")) {
      checks++;
      if (c.compliant === true) compliant++;
      if (big(c.outsideMicroSiu) > 0n) outside++;
      const held = big(c.heldMicroSiu);
      reserve += held;
      const next = Number(c.atClose) + 1;
      const rate = printAt.get(next);
      let s = 0n;
      let u = 0n;
      for (const e of r.log) {
        if (win.get(e.window) !== next) continue;
        // spent on work: AGU-lab or claims paid for work, and claims the agent presented and had served
        if (e.actor === c.actor && e.kind === "payment" && e.forced !== true && e.scripted !== true && (e.currency === "agu" || e.currency === "claims"))
          s += big(e.valueMicroSiu);
        if (e.kind === "claim-serve" && e.holder === c.actor && e.passed === true) s += big(e.milli) * 1_000n;
        // unwound: AGU-lab sold back for USDC in the first round after the close, valued at that window's print
        if (e.actor === c.actor && e.kind === "exit" && e.round === 0 && rate !== undefined) u += (big(e.usdc) * 1_000_000_000n) / rate;
      }
      spent += s < held ? s : held;
      unwound += u < held ? u : held;
    }
  }
  return {
    checks,
    compliant,
    spentOnWorkShare: share(spent, reserve),
    unwoundShare: share(unwound, reserve),
    attemptsOutsideHorizon: outside,
  };
}

// ---- the whole report ------------------------------------------------------------------------------------------------------------------------------
export interface ArmScore {
  arm: Arm;
  runs: string[];
  exchange: Exchange;
  account: Account;
  storeOfValue: StoreOfValue;
  deferredPayment: DeferredPayment;
  comparability: Comparability;
  armB?: ArmBExtras;
  killSignals: string[];
  /** arm A only: any two kill signals close the AGU-lab question for this design */
  closed?: boolean;
}

export function scoreArm(
  arm: Arm,
  runs: readonly V3aRunLog[],
  params: EconomyParams,
  passBps: Readonly<Record<string, Partial<Record<string, number>>>>,
  codings?: Codings,
): ArmScore {
  const v = params.v3a;
  if (v === undefined) throw new Error("not a v3a parameters file");
  const mc = v.minCounts;
  const exchange = scoreExchange(runs, mc.exchange ?? 20);
  const account = scoreAccount(runs, codings, mc.account ?? 40);
  const storeOfValue = scoreStoreOfValue(runs, v.windows, mc.storeOfValue ?? 9);
  const deferredPayment = scoreDeferredPayment(runs, mc.deferredPayment ?? 20);
  const comparability = scoreComparability(runs, passBps, v.failedWorkPays, mc.comparabilityPerDisplay ?? 20, mc.comparabilityKillPerDisplay ?? 40);
  const named: [string, Verdict][] = [
    ["exchange", exchange.verdict],
    ["account", account.verdict],
    ["store of value", storeOfValue.verdict],
    ["deferred payment", deferredPayment.verdict],
    ["comparability", comparability.verdict],
  ];
  const killSignals = named.filter(([, x]) => x === "kill").map(([n]) => n);
  return {
    arm,
    runs: runs.map((r) => r.label),
    exchange,
    account,
    storeOfValue,
    deferredPayment,
    comparability,
    ...(arm === "B" ? { armB: scoreArmB(runs) } : {}),
    killSignals,
    ...(arm === "A" ? { closed: killSignals.length >= 2 } : {}),
  };
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const msiu = (micro: bigint): string => `${micro / 1_000n} mSIU`;

export function renderArmScore(s: ArmScore): string {
  const L: string[] = [`## Arm ${s.arm} (${s.runs.length} run${s.runs.length === 1 ? "" : "s"}: ${s.runs.join(", ")})`, ""];
  const x = s.exchange;
  L.push(
    `- **Exchange** — ${x.verdict}: AGU-lab ${pct(x.aguShare)} of ${x.payments} eligible payments by value (AGU-lab ${msiu(x.byCurrencyMicroSiu.agu)}, USDC ${msiu(x.byCurrencyMicroSiu.usdc)}); left out: ${x.excluded.forced} forced, ${x.excluded.scripted} code, ${x.excluded.payerCouldNotPayBoth} where the payer could not pay in both, ${x.excluded.payeeDidNotAcceptBoth} where the payee did not accept both, and ${x.claimPaymentsLeftOut} briefs paid in work claims (reported under deferred payment).`,
  );
  const a = s.account;
  L.push(
    `- **Account** — ${a.verdict}${a.reason !== undefined ? ` (${a.reason})` : ""}: ${a.decisions} priced decisions; kappa ${a.kappa === null ? "n/a" : a.kappa.toFixed(3)}; ${a.agreed} agreed; SIU ${pct(a.siuShare)} (SIU or both ${pct(a.siuOrBothShare)}); binding quotes in mSIU ${pct(a.bindingQuotes.msiuShare)} (${a.bindingQuotes.msiu} of ${a.bindingQuotes.msiu + a.bindingQuotes.usd})${a.hand !== undefined ? `; hand-coded ${a.hand.n}, kappa vs coder A ${a.hand.vsA?.toFixed(3) ?? "n/a"}, vs coder B ${a.hand.vsB?.toFixed(3) ?? "n/a"}` : ""}.`,
  );
  const sv = s.storeOfValue;
  L.push(
    `- **Store of value** — ${sv.verdict}: median work share at window 8 ${pct(sv.finalMedian)} (${sv.finalN} agents); in the low-volatility runs ${pct(sv.lowVolFinalMedian)} (${sv.lowVolFinalN}); by close: ${sv.medianByClose.map((c) => `w${c.close} ${pct(c.median)}`).join(", ")}. Against NAV with the buffer: ${pct(sv.withBuffer.finalMedian)} at window 8 (low volatility ${pct(sv.withBuffer.lowVolFinalMedian)}); by close: ${sv.withBuffer.medianByClose.map((c) => `w${c.close} ${pct(c.median)}`).join(", ")}.`,
  );
  const d = s.deferredPayment;
  L.push(
    `- **Deferred payment** — ${d.verdict}: missed ${d.missed} of ${d.worthwhile} worthwhile purchases (${pct(d.missedShare)}); forward commitments by value: AGU-lab ${pct(d.forwardShares.agu)}, USDC ${pct(d.forwardShares.usdc)}; briefs paid in work claims: ${d.claimTransfers.count} (${msiu(d.claimTransfers.valueMicroSiu)}).`,
  );
  const c = s.comparability;
  L.push(
    `- **Comparability** — ${c.verdict}: cheapest per accepted mSIU taken in ${pct(c.siuFirst.share)} of ${c.siuFirst.decisions} SIU-first decisions and ${pct(c.dollarsFirst.share)} of ${c.dollarsFirst.decisions} dollars-first (difference ${c.differencePoints === null ? "n/a" : `${c.differencePoints.toFixed(1)} points`}); decisions: ${c.byKind.brief} briefs, ${c.byKind.commission} commissions, ${c.byKind.claims} claim purchases.`,
  );
  if (s.armB !== undefined)
    L.push(
      `- **Arm B rule** — ${s.armB.compliant} of ${s.armB.checks} checks compliant; reserve spent on work ${pct(s.armB.spentOnWorkShare)}; unwound within one round of a close ${pct(s.armB.unwoundShare)}; checks with claims outside the horizon ${s.armB.attemptsOutsideHorizon}.`,
    );
  L.push(
    "",
    s.arm === "A"
      ? `**Kill signals: ${s.killSignals.length === 0 ? "none" : s.killSignals.join(", ")} — ${s.closed === true ? "AGU-LAB QUESTION CLOSED for this design (two or more)" : "not closed"}.** An n/a never counts.`
      : `Kill signals in arm B (reported, never part of the kill rule): ${s.killSignals.length === 0 ? "none" : s.killSignals.join(", ")}.`,
    "",
  );
  return L.join("\n");
}
