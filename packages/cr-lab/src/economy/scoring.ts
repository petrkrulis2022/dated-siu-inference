/**
 * Scoring for the pre-registered measures and the kill criteria (`docs/marketplace_plan.md` §16.9), written and committed before the first counted window (D87; the owner's
 * instructions of 2026-11-07) so no counted result can change how it is computed. Every share is reported as a count and a direction, never a significance test — §16.9's
 * pre-registration already says the counted windows report counts and direction only.
 *
 * Works from the ORDERED LOG alone (`LogEntry[]`) plus the committed, frozen parameters file, never from a live `World`: the same code then scores a live counted run right
 * after it finishes, or a stored log file read back later (the rehearsal's and DW4's, for instance, or any one of the seven counted windows' own logs on their own). This
 * matches the project's own publication principle — the log is "verifiable by anyone" — and means the scoring can be tested, right now, against real stored runs without
 * re-spending anything.
 *
 * Exit classes (model agents only; a scripted issuer's own AGU-lab income sale is reported separately, see `scoreIssuerExits` — it is code, not an agent's choice):
 *  - "structural dollar route": the agent sold AGU-lab and, in the same window, placed a front-claim order or bought claims ahead for the next window — the dollar leg of
 *    buying work ahead (R5/Q5a pays in USDC by design). Scored BOTH ways (the owner, 2026-11-07): the PRIMARY thesis share treats it as neutral, exactly like any other
 *    dollar cost (not held against the thesis); the SECONDARY share counts it against, as if it were a price-move or fear exit. Reported side by side so the owner can see
 *    which reading the 20% threshold falls under.
 *  - "dollar cost" / "price move" / "fear" / "other": every other exit, tagged BLIND (`exitsToTagBlind`, `scoreThesis`'s `tags` argument) from its reasoning text ALONE —
 *    every identifying detail (the agent, the window, the amount) is stripped before a human reads it — before the thesis's 20% threshold is scored (the owner: unclassified
 *    exits are tagged blind after the run, before the threshold is scored).
 *
 * Proxies, pre-registered (the owner, 2026-11-07), because the engine has no literal signal for what §16.9's prose describes:
 *  - "Quoting in dollars when free to choose" (kill criterion 3) is read from agents' own `message` tool calls: a dollar sign or a number followed by "USD"/"USDC" in the
 *    free text counts as quoting in dollars (`DOLLAR_IN_TEXT`). `post_quote`'s own price argument is always in mSIU by the tool's schema (`parse.ts`), so it can never
 *    supply this signal — only a model's own freely-chosen wording in a message can.
 *  - "Median hops stays at one" (kill criterion 2) and "near-universal conversion to USDC on receipt" (kill criterion 1) both need a notion of "hops" over a FUNGIBLE asset,
 *    which has no per-unit provenance once it is in an agent's balance. Both are scored at the SAME single level the engine's own development-window criterion already
 *    uses ("AGU-lab circulated at least two hops" = at least one onward-spend event exists, `report.ts`'s `onwardSpends`): a receipt's hop count is 1 if that agent is never
 *    seen paying onward before converting or sitting on it, 2 if it is seen paying onward at least once. This cannot show a receipt's money moving three or more hops
 *    without ambiguity about whose balance it then came from, so it is a floor, never an exact count; the median of this per-receipt value is what "median hops" reports.
 *  - The "near-universal" conversion threshold is pre-registered here at 90% (no published number exists to use instead); the "most windows" buying-ahead threshold is a
 *    strict majority (more than half of the windows considered, `windowsAtLeastQuarter * 2 > windowsConsidered`).
 */
import { TASKS, type TaskId } from "../tasks/instances.js";
import { siuFirstForWindow } from "./board.js";
import { asBigInt, currencyOfEscrow, type Currency, type LogEntry } from "./log.js";
import type { EconomyParams } from "./params.js";
import { reasoningBeforeOf } from "./overview.js";
import { needsSchedule } from "./runner.js";
import { AGU_ISSUER } from "./world.js";

export type ExitClass = "structural dollar route" | "dollar cost" | "price move" | "fear" | "other";
const BLIND_TAGGED: readonly ExitClass[] = ["dollar cost", "price move", "fear", "other"];

/** v3a Phase 2 item 3: a receipt-based measure, scored separately for each currency a payment can move in */
export type PerCurrency<T> = Record<Currency, T>;

/** the log's own window (a day label) in run order, mapped back to the numeric window index every other part of the engine uses: 0 for genesis's own day, 1..N for the windows */
export function windowIndexOf(log: readonly LogEntry[]): Map<string, number> {
  const order: string[] = [];
  for (const e of log) if (!order.includes(e.window)) order.push(e.window);
  // D144 (found in Phase 3): genesis runs before window 1 and writes on its own day, so a log that begins with genesis's day numbers that day 0 and the windows 1..N,
  // as the engine does. This counted genesis's day as window 1, shifting every window by one: buying ahead was checked against the wrong window's needs, half the
  // comparability decisions took the wrong display order, and a window past the last was scored. A log with no genesis day (a constructed fixture) numbers from 1.
  const first = order[0];
  const genesisDay =
    first !== undefined &&
    log.some((e) => e.window === first && (e.kind === "genesis" || e.kind === "setup")) &&
    !log.some((e) => e.window === first && e.kind === "turn");
  return new Map(order.map((d, i) => [d, genesisDay ? i : i + 1]));
}

const modelAgentIds = (params: EconomyParams): ReadonlySet<string> =>
  new Set([...params.agents.research, ...params.agents.demand, params.agents.hedger]);

/** the fixed prefix on `order_front_claim`'s own synthetic "message" entry (`world.ts`'s `#act`), so it is never mistaken for an agent's own free-text message */
const FRONT_ORDER_PREFIX = "front-claim order: ";
const FRONT_ORDER_TASK = /^front-claim order: [\d.]+ SIU of (\S+) for the next window$/;

/** how a buying-ahead action was paid: v3a logs it on both kinds of action; a front-claim order logged before that is "unrecorded", and a claim mint before v2 was USDC-only */
type AheadUnit = Currency | "unrecorded";
interface AheadAction {
  agent: string;
  task: string | undefined;
  forWindow: number;
  unit: AheadUnit;
}

/** every `(agent, forWindow)` pair with a buying-ahead action: an `order_front_claim` (the synthetic message) or a `buy_claims` (the `claim-mint` entry) */
function buyingAheadActions(log: readonly LogEntry[]): AheadAction[] {
  const dayIndex = windowIndexOf(log);
  const out: AheadAction[] = [];
  for (const e of log) {
    if (
      e.kind === "message" &&
      e.to === AGU_ISSUER &&
      typeof e.text === "string" &&
      e.text.startsWith(FRONT_ORDER_PREFIX)
    ) {
      const k = dayIndex.get(e.window);
      const m = FRONT_ORDER_TASK.exec(e.text);
      const unit: AheadUnit = e.pay === "agu" || e.pay === "usdc" ? e.pay : "unrecorded";
      if (k !== undefined) out.push({ agent: e.actor, task: m?.[1], forWindow: k + 1, unit });
    }
    if (e.kind === "claim-mint")
      out.push({
        agent: e.actor,
        task: e.task as string,
        forWindow: e.forWindow as number,
        unit: e.payUnit === "agu" ? "agu" : "usdc",
      });
  }
  return out;
}

export interface BlindExit {
  /** stable so a returned tag can be matched back to this exit; never the agent, the window or any amount */
  key: string;
  reasoning: string;
}

interface ExitFact {
  seq: number;
  agent: string;
  structural: boolean;
  reasoning: string;
}

/** every "exit" (sell_agu) entry, classified "structural dollar route" where a buying-ahead action for the next window shares its window, left unclassified otherwise */
function exitFacts(log: readonly LogEntry[]): ExitFact[] {
  const dayIndex = windowIndexOf(log);
  const ahead = buyingAheadActions(log);
  const aheadKeys = new Set(ahead.map((a) => `${a.agent}|${a.forWindow}`));
  const out: ExitFact[] = [];
  for (const e of log) {
    if (e.kind !== "exit") continue;
    const k = dayIndex.get(e.window);
    const structural = k !== undefined && aheadKeys.has(`${e.actor}|${k + 1}`);
    out.push({ seq: e.seq, agent: e.actor, structural, reasoning: reasoningBeforeOf(log, e, 2000) });
  }
  return out;
}

/** the exits still unclassified after the structural check, stripped to their reasoning alone, for a blind read before the thesis share is scored */
export function exitsToTagBlind(log: readonly LogEntry[]): BlindExit[] {
  return exitFacts(log)
    .filter((e) => !e.structural)
    .map((e) => ({ key: `exit-${e.seq}`, reasoning: e.reasoning }));
}

export interface ExitScoring {
  total: number;
  byClass: Record<ExitClass, number>;
  untagged: string[];
  primaryAgainst: number;
  secondaryAgainst: number;
  primaryShare: number | null;
  secondaryShare: number | null;
  primaryFails: boolean | null;
  secondaryFails: boolean | null;
}

/**
 * `tags` maps every `exitsToTagBlind` key to the class a blind read of its reasoning gave it. An exit missing from `tags` is reported in `untagged` and left out of every
 * share (so a partial tag set never silently understates the thesis's violation share): `tags` must cover every key `exitsToTagBlind` returns before the result is final.
 */
export function scoreThesis(log: readonly LogEntry[], tags: ReadonlyMap<string, ExitClass>): ExitScoring {
  const facts = exitFacts(log);
  const byClass: Record<ExitClass, number> = {
    "structural dollar route": 0,
    "dollar cost": 0,
    "price move": 0,
    fear: 0,
    other: 0,
  };
  const untagged: string[] = [];
  for (const e of facts) {
    if (e.structural) {
      byClass["structural dollar route"]++;
      continue;
    }
    const key = `exit-${e.seq}`;
    const tag = tags.get(key);
    if (tag === undefined || !BLIND_TAGGED.includes(tag)) {
      untagged.push(key);
      continue;
    }
    byClass[tag]++;
  }
  const scored = facts.length - untagged.length;
  const primaryAgainst = byClass["price move"] + byClass.fear;
  const secondaryAgainst = primaryAgainst + byClass["structural dollar route"];
  const primaryShare = scored === 0 ? null : primaryAgainst / scored;
  const secondaryShare = scored === 0 ? null : secondaryAgainst / scored;
  return {
    total: facts.length,
    byClass,
    untagged,
    primaryAgainst,
    secondaryAgainst,
    primaryShare,
    secondaryShare,
    primaryFails: primaryShare === null ? null : primaryShare >= 0.2,
    secondaryFails: secondaryShare === null ? null : secondaryShare >= 0.2,
  };
}

export interface IssuerExitPayer {
  agent: string;
  agu: bigint;
  /** 1: bought fresh from the participant just before paying the issuer; 2: had itself received AGU-lab through an earlier escrow before paying the issuer (the same floor
   *  this module uses everywhere a hop count is reported — see the module's own doc comment on why it can go no deeper for a fungible asset) */
  hops: 1 | 2;
}
export interface IssuerExitReport {
  issuer: string;
  window: number;
  agu: bigint;
  usdc: bigint;
  payers: IssuerExitPayer[];
}

/** the scripted issuers' own AGU-lab income sales (code, not an agent's choice — `world.ts`'s `closeWindow`), reported as dollar-cost exits separately from model agents' */
export function scoreIssuerExits(log: readonly LogEntry[]): IssuerExitReport[] {
  const dayIndex = windowIndexOf(log);
  // v3a Phase 2 item 3: the issuer sells AGU-lab, so only AGU-lab payments into it (and, for the hop, AGU-lab receipts by its payer) are traced; a USDC commission was
  // counted as one of the sale's AGU-lab payments
  const opens = log.filter((e) => e.kind === "escrow-open" && currencyOfEscrow(e) === "agu");
  const openByEscrow = new Map(opens.map((o) => [o.escrow as string, o]));
  const paidOf = (e: LogEntry): bigint | undefined => (e.kind === "escrow-settle" ? asBigInt(e.paid) : undefined);
  const isReceipt = (e: LogEntry): boolean => (paidOf(e) ?? 0n) > 0n;
  const sales = log.filter((e) => e.kind === "participant-buyback" && e.issuerCode === true);
  return sales.map((sale) => {
    const issuer = sale.from as string;
    const inflows = log.filter(
      (e) =>
        isReceipt(e) &&
        e.window === sale.window &&
        e.seq < sale.seq &&
        openByEscrow.get(e.escrow as string)?.to === issuer,
    );
    const payers: IssuerExitPayer[] = inflows.map((inflow) => {
      const open = openByEscrow.get(inflow.escrow as string) as LogEntry;
      const payer = open.actor;
      const everReceived = log.some(
        (e) => isReceipt(e) && e.seq < open.seq && openByEscrow.get(e.escrow as string)?.to === payer,
      );
      return { agent: payer, agu: paidOf(inflow) ?? 0n, hops: everReceived ? 2 : 1 };
    });
    return {
      issuer,
      window: dayIndex.get(sale.window) ?? 0,
      agu: asBigInt(sale.agu) ?? 0n,
      usdc: asBigInt(sale.usdc) ?? 0n,
      payers,
    };
  });
}

interface ReceiptFact {
  onward: boolean;
  convertedToUsdc: boolean;
}

/**
 * Every exit's class, keyed by its `seq` (D132): a structural exit is classed by code (`exitFacts`), every other exit only once `tags` supplies it. An exit missing from
 * both is left out of the map -- callers must treat a missing key as "not classifiable yet", never as any particular class.
 */
function exitClassBySeqOf(log: readonly LogEntry[], tags: ReadonlyMap<string, ExitClass>): Map<number, ExitClass> {
  const out = new Map<number, ExitClass>();
  for (const f of exitFacts(log)) {
    const cls = f.structural ? "structural dollar route" : tags.get(`exit-${f.seq}`);
    if (cls !== undefined) out.set(f.seq, cls);
  }
  return out;
}

/**
 * Every receipt IN `currency` (an escrow paid to a model agent, never an issuer or the gate runner), whether that agent is later seen paying onward IN THE SAME currency,
 * and whether it later converted to USDC. `exitClassBySeq`, when given, makes "converted" read the NEAREST subsequent exit's own classification (D132): a forced exit (a
 * "structural dollar route" or a blind-tagged "dollar cost") does not count as conversion, since kill criterion 1 is about revealed preference, not plumbing. An
 * unclassified or voluntary exit ("price move"/"fear"/"other") still counts, same as before. Omitting `exitClassBySeq` keeps the old "any later exit at all" reading,
 * which `scoreCirculation` and `scoreHops` rely on only for `onward` -- they never read `convertedToUsdc`, so they are unaffected by this fix.
 *
 * v3a Phase 2 item 3 (docs/v2-code-check.md 6b): this said "every AGU-lab receipt" and never filtered by currency, so v2's six USDC brief payments were scored as
 * AGU-lab receipts by kill criteria 1 and 2 and by circulation alike.
 */
function modelAgentReceipts(
  log: readonly LogEntry[],
  params: EconomyParams,
  currency: Currency,
  exitClassBySeq?: ReadonlyMap<number, ExitClass>,
): ReceiptFact[] {
  const agents = modelAgentIds(params);
  const opens = log.filter((e) => e.kind === "escrow-open" && currencyOfEscrow(e) === currency);
  const settles = log.filter((e) => e.kind === "escrow-settle" && (asBigInt(e.paid) ?? 0n) > 0n);
  const openByEscrow = new Map(opens.map((o) => [o.escrow as string, o]));
  const exits = log.filter((e) => e.kind === "exit");
  const out: ReceiptFact[] = [];
  for (const s of settles) {
    const open = openByEscrow.get(s.escrow as string);
    if (open === undefined) continue;
    const seller = open.to as string;
    if (!agents.has(seller)) continue;
    const nearestExit = exits
      .filter((e) => e.actor === seller && e.seq > s.seq)
      .sort((a, b) => a.seq - b.seq)[0];
    const convertedToUsdc =
      exitClassBySeq === undefined
        ? nearestExit !== undefined
        : nearestExit !== undefined &&
          exitClassBySeq.get(nearestExit.seq) !== "structural dollar route" &&
          exitClassBySeq.get(nearestExit.seq) !== "dollar cost";
    out.push({ onward: opens.some((o) => o.actor === seller && o.seq > s.seq), convertedToUsdc });
  }
  return out;
}

export interface CirculationScoring {
  onwardSpends: number;
  opportunities: number;
  share: number | null;
  holds: boolean | null;
}

/** "received currency is spent onward in at least half of opportunities" (§16.9), for receipts in `currency`; model agents only — an issuer's income sale is never a "receipt of currency" by an agent */
export function scoreCirculation(log: readonly LogEntry[], params: EconomyParams, currency: Currency): CirculationScoring {
  const receipts = modelAgentReceipts(log, params, currency);
  const onwardSpends = receipts.filter((r) => r.onward).length;
  const share = receipts.length === 0 ? null : onwardSpends / receipts.length;
  return {
    onwardSpends,
    opportunities: receipts.length,
    share,
    holds: share === null ? null : share >= 0.5,
  };
}

export interface ConversionScoring {
  converted: number;
  opportunities: number;
  share: number | null;
  fails: boolean;
  /** false for USDC receipts: a USDC receipt has nothing to convert to USDC, so its share is n/a by definition, never 0% */
  applicable: boolean;
}

/**
 * Kill criterion 1: "agents convert received currency to USDC almost every time"; the 90% threshold is pre-registered here, as the module's own doc comment explains.
 * `tags` is the SAME blind-tag map `scoreThesis` takes (D132): "converted" only counts a receipt whose nearest subsequent exit is not a forced one.
 */
export function scoreConversionToUsdc(
  log: readonly LogEntry[],
  params: EconomyParams,
  tags: ReadonlyMap<string, ExitClass>,
  currency: Currency,
): ConversionScoring {
  const receipts = modelAgentReceipts(log, params, currency, exitClassBySeqOf(log, tags));
  if (currency === "usdc")
    return { converted: 0, opportunities: receipts.length, share: null, fails: false, applicable: false };
  const converted = receipts.filter((r) => r.convertedToUsdc).length;
  const share = receipts.length === 0 ? null : converted / receipts.length;
  return { converted, opportunities: receipts.length, share, fails: share !== null && share >= 0.9, applicable: true };
}

export interface HopsScoring {
  values: number[];
  median: number | null;
  fails: boolean;
}

/** kill criterion 2: "median hops stays at one" (the per-receipt floor this module's doc comment explains; 1 = money stopped with this agent, 2 = it was seen paid onward), for receipts in `currency` */
export function scoreHops(log: readonly LogEntry[], params: EconomyParams, currency: Currency): HopsScoring {
  const values = modelAgentReceipts(log, params, currency).map((r) => (r.onward ? 2 : 1));
  const median = medianOf(values);
  return { values, median, fails: median !== null && median <= 1 };
}

function medianOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

export interface BuyingAheadWindow {
  window: number;
  covered: number;
  total: number;
  share: number | null;
  atLeastQuarter: boolean | null;
}
export interface BuyingAheadScoring {
  perWindow: BuyingAheadWindow[];
  windowsConsidered: number;
  windowsAtLeastQuarter: number;
  holds: boolean | null;
  /** kill criterion 4: no demand agent ever bought ahead for a need it could see coming, in any window of the run */
  neverCovered: boolean;
  /** v3a Phase 2 item 3: every buying-ahead action in the run, by the currency it was paid in */
  actionsByUnit: Record<AheadUnit, number>;
}

/** the run's REAL seed, from its own `"genesis"` log entry (D133) -- never guessed from `--params`, which may still carry the committed file's dev default */
export function genesisSeedOf(log: readonly LogEntry[]): string | undefined {
  const seed = log.find((e) => e.kind === "genesis")?.seed;
  return typeof seed === "string" ? seed : undefined;
}

/** "the hedger and demand agents cover at least a quarter of the next window's known needs in most windows" (§16.9) */
export function scoreBuyingAhead(log: readonly LogEntry[], params: EconomyParams): BuyingAheadScoring {
  const dayIndex = windowIndexOf(log);
  // the last window's number (D144: never the count of day labels, which includes genesis's own day)
  const windowCount = Math.max(0, ...dayIndex.values());
  const needsFor = needsSchedule(
    genesisSeedOf(log) ?? params.seed,
    TASKS.filter((t): t is TaskId => t !== "CR-VS"),
  );
  const ahead = buyingAheadActions(log);
  const coveredFor = new Set(ahead.filter((a) => a.task !== undefined).map((a) => `${a.agent}|${a.task}|${a.forWindow}`));
  const hedgerAheadWindows = new Set(ahead.filter((a) => a.agent === params.agents.hedger).map((a) => a.forWindow));
  const perWindow: BuyingAheadWindow[] = [];
  for (let k = 1; k < windowCount; k++) {
    let covered = 0;
    let total = 0;
    for (const a of params.agents.demand)
      for (const t of new Set(needsFor(a, k + 1))) {
        total++;
        if (coveredFor.has(`${a}|${t}|${k + 1}`)) covered++;
      }
    // the hedger's forward obligation isn't task-specific (any two passing outputs cover a brief): count it as one slot, covered by any buying-ahead action of its own
    total++;
    if (hedgerAheadWindows.has(k + 1)) covered++;
    const share = total === 0 ? null : covered / total;
    perWindow.push({ window: k, covered, total, share, atLeastQuarter: share === null ? null : share >= 0.25 });
  }
  const windowsConsidered = perWindow.length;
  const windowsAtLeastQuarter = perWindow.filter((w) => w.atLeastQuarter === true).length;
  const actionsByUnit: Record<AheadUnit, number> = { agu: 0, usdc: 0, unrecorded: 0 };
  for (const a of ahead) actionsByUnit[a.unit]++;
  return {
    perWindow,
    windowsConsidered,
    windowsAtLeastQuarter,
    holds: windowsConsidered === 0 ? null : windowsAtLeastQuarter * 2 > windowsConsidered,
    neverCovered: perWindow.every((w) => w.covered === 0),
    actionsByUnit,
  };
}

export interface ComparabilityScoring {
  siuFirstCheapestShare: number | null;
  dollarsFirstCheapestShare: number | null;
  siuFirstSample: number;
  dollarsFirstSample: number;
  holds: boolean | null;
  /** v3a Phase 2 item 3: the accepted offers in the sample (both display orders), by what paid for them */
  acceptedPaidIn: Record<Currency | "claims", number>;
}

/**
 * Every acceptance of a quote, once each, in log order: an escrow opened for it (paid in its own unit), or (v3a Phase 2 item 7) the first claim transferred for it (paid
 * in work claims, no escrow)
 */
function quoteAcceptances(
  log: readonly LogEntry[],
): { entry: LogEntry; quote: string; paidIn: Currency | "claims" | undefined }[] {
  const seen = new Set<string>();
  const out: { entry: LogEntry; quote: string; paidIn: Currency | "claims" | undefined }[] = [];
  for (const e of log) {
    if (typeof e.quote !== "string" || seen.has(e.quote)) continue;
    if (e.kind !== "escrow-open" && e.kind !== "claim-transfer") continue;
    seen.add(e.quote);
    // an escrow opened for a quote is its acceptance whatever it carries; its currency is read where the entry states one
    out.push({ entry: e, quote: e.quote, paidIn: e.kind === "claim-transfer" ? "claims" : currencyOfEscrow(e) });
  }
  return out;
}

/**
 * "With SIU shown first, demand agents pick the cheapest offer per passing job more often than with dollars first" (§16.9). Only counted where a real choice existed — at
 * least one other quote was posted for the same need before this one was accepted — and only for briefs that went on to pass (a "passing job"); a single-offer acceptance
 * is excluded as it cannot discriminate between the two display orders.
 */
export function scoreComparability(log: readonly LogEntry[]): ComparabilityScoring {
  const dayIndex = windowIndexOf(log);
  const quotes = new Map(
    log
      .filter((e) => e.kind === "quote")
      .map((e) => [
        e.quote as string,
        { seq: e.seq, need: e.need as string, priceMicroSiu: asBigInt(e.priceMicroSiu) ?? 0n },
      ]),
  );
  const passed = new Set(
    log.filter((e) => e.kind === "gate" && e.brief !== undefined && e.passed === true).map((e) => e.brief as string),
  );
  let siuN = 0;
  let siuCheapest = 0;
  let dollarsN = 0;
  let dollarsCheapest = 0;
  const acceptedPaidIn: Record<Currency | "claims", number> = { agu: 0, usdc: 0, claims: 0 };
  for (const { entry: acc, quote, paidIn } of quoteAcceptances(log)) {
    const q = quotes.get(quote);
    if (q === undefined || !passed.has(quote)) continue;
    const alternatives = [...quotes.values()].filter((x) => x.need === q.need && x.seq < acc.seq);
    if (alternatives.length < 2) continue;
    const cheapest = alternatives.reduce((m, x) => (x.priceMicroSiu < m ? x.priceMicroSiu : m), alternatives[0]?.priceMicroSiu ?? 0n);
    const pickedCheapest = q.priceMicroSiu <= cheapest;
    const k = dayIndex.get(acc.window);
    if (k === undefined) continue;
    if (paidIn !== undefined) acceptedPaidIn[paidIn]++;
    if (siuFirstForWindow(k)) {
      siuN++;
      if (pickedCheapest) siuCheapest++;
    } else {
      dollarsN++;
      if (pickedCheapest) dollarsCheapest++;
    }
  }
  const siuShare = siuN === 0 ? null : siuCheapest / siuN;
  const dollarsShare = dollarsN === 0 ? null : dollarsCheapest / dollarsN;
  return {
    siuFirstCheapestShare: siuShare,
    dollarsFirstCheapestShare: dollarsShare,
    siuFirstSample: siuN,
    dollarsFirstSample: dollarsN,
    holds: siuShare === null || dollarsShare === null ? null : siuShare > dollarsShare,
    acceptedPaidIn,
  };
}

/** a dollar amount in an agent's own free text: "$12", "12 USD" or "12 USDC" — never a case `post_quote`'s schema can produce (kill criterion 3's proxy) */
const DOLLAR_IN_TEXT = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|usdc)\b/i;

export interface QuotingInDollars {
  count: number;
  messages: number;
  share: number | null;
  fails: boolean;
  /** v3a Phase 2 item 3: every posted quote by the unit that binds at acceptance -- reported beside the pre-registered message proxy, never scored into it */
  bindingQuotesByUnit: { siu: number; usdc: number };
}

/** kill criterion 3: "agents quote in dollars when free to choose" — the proxy is a dollar amount in a `message` tool call's own text (see the module's doc comment) */
export function scoreQuotingInDollars(log: readonly LogEntry[], params: EconomyParams): QuotingInDollars {
  const agents = modelAgentIds(params);
  const messages = log.filter(
    (e) =>
      e.kind === "message" &&
      agents.has(e.actor) &&
      typeof e.text === "string" &&
      !(e.text as string).startsWith(FRONT_ORDER_PREFIX),
  );
  const count = messages.filter((e) => DOLLAR_IN_TEXT.test(e.text as string)).length;
  const share = messages.length === 0 ? null : count / messages.length;
  const quotes = log.filter((e) => e.kind === "quote");
  const usdc = quotes.filter((e) => e.priceUnit === "usdc").length;
  return {
    count,
    messages: messages.length,
    share,
    fails: share !== null && share > 0,
    bindingQuotesByUnit: { siu: quotes.length - usdc, usdc },
  };
}

/**
 * Kill criteria 1 and 2 are reported for both currencies and FIRE on the AGU-lab sample alone: they close the question of whether AGU-lab circulates, and a USDC receipt
 * says nothing about that (v3a Phase 2 item 3). An empty AGU-lab sample is n/a and never fires.
 */
export interface KillCriteria {
  conversionOnReceipt: PerCurrency<ConversionScoring>;
  medianHops: PerCurrency<HopsScoring>;
  quotingInDollars: QuotingInDollars;
  noBuyingAheadForVisibleNeeds: boolean;
  failCount: number;
  fails: boolean;
}

/** "any two of these close the currency question for this design" (§16.9) */
export function scoreKillCriteria(
  log: readonly LogEntry[],
  params: EconomyParams,
  buyingAhead: BuyingAheadScoring,
  tags: ReadonlyMap<string, ExitClass>,
): KillCriteria {
  const conversionOnReceipt: PerCurrency<ConversionScoring> = {
    agu: scoreConversionToUsdc(log, params, tags, "agu"),
    usdc: scoreConversionToUsdc(log, params, tags, "usdc"),
  };
  const medianHops: PerCurrency<HopsScoring> = { agu: scoreHops(log, params, "agu"), usdc: scoreHops(log, params, "usdc") };
  const quotingInDollars = scoreQuotingInDollars(log, params);
  const noBuyingAheadForVisibleNeeds = buyingAhead.neverCovered;
  const failCount = [
    conversionOnReceipt.agu.fails,
    medianHops.agu.fails,
    quotingInDollars.fails,
    noBuyingAheadForVisibleNeeds,
  ].filter(Boolean).length;
  return {
    conversionOnReceipt,
    medianHops,
    quotingInDollars,
    noBuyingAheadForVisibleNeeds,
    failCount,
    fails: failCount >= 2,
  };
}

export interface ScoringReport {
  thesis: ExitScoring;
  issuerExits: IssuerExitReport[];
  circulation: PerCurrency<CirculationScoring>;
  buyingAhead: BuyingAheadScoring;
  comparability: ComparabilityScoring;
  killCriteria: KillCriteria;
}

export function scoreRun(
  log: readonly LogEntry[],
  params: EconomyParams,
  tags: ReadonlyMap<string, ExitClass>,
): ScoringReport {
  const buyingAhead = scoreBuyingAhead(log, params);
  return {
    thesis: scoreThesis(log, tags),
    issuerExits: scoreIssuerExits(log),
    circulation: { agu: scoreCirculation(log, params, "agu"), usdc: scoreCirculation(log, params, "usdc") },
    buyingAhead,
    comparability: scoreComparability(log),
    killCriteria: scoreKillCriteria(log, params, buyingAhead, tags),
  };
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const verdict = (ok: boolean | null): string => (ok === null ? "n/a (no sample)" : ok ? "HOLDS" : "DOES NOT HOLD");
const CURRENCY_NAME: Record<Currency, string> = { agu: "AGU-lab", usdc: "USDC" };

/** v3a Phase 2 item 3: one receipt-based figure per currency, an empty sample always "n/a (0 receipts)" with its count, never a percentage of nothing */
function circulationLine(c: CirculationScoring, cur: Currency): string {
  if (c.opportunities === 0) return `- ${CURRENCY_NAME[cur]}: n/a (0 receipts)`;
  return `- ${CURRENCY_NAME[cur]}: ${c.onwardSpends} of ${c.opportunities} receipts spent onward in ${CURRENCY_NAME[cur]} (${pct(c.share)}) — ${verdict(c.holds)}`;
}
function conversionText(c: ConversionScoring, cur: Currency): string {
  if (!c.applicable) return `${CURRENCY_NAME[cur]}: n/a (a USDC receipt is already USDC)`;
  if (c.opportunities === 0) return `${CURRENCY_NAME[cur]}: n/a (0 receipts)`;
  return `${CURRENCY_NAME[cur]}: ${c.converted} of ${c.opportunities} receipts converted (${pct(c.share)})`;
}
function hopsText(h: HopsScoring, cur: Currency): string {
  if (h.median === null) return `${CURRENCY_NAME[cur]}: n/a (0 receipts)`;
  return `${CURRENCY_NAME[cur]}: ${h.median} (${h.values.length} receipts)`;
}

export function renderScoringReport(r: ScoringReport): string {
  const lines: string[] = ["## Pre-registered scoring (§16.9)", ""];
  lines.push("### Thesis: agents exit only for sweeps and dollar costs", "");
  lines.push("- (an exit is a sale of AGU-lab for USDC, so this measure is AGU-lab's by definition)");
  lines.push(
    `- exits: ${r.thesis.total} total (${r.thesis.untagged.length} untagged); by class: ${Object.entries(
      r.thesis.byClass,
    )
      .map(([k, v]) => `${k} ${v}`)
      .join(", ")}`,
  );
  lines.push(
    `- PRIMARY (structural dollar route neutral): ${pct(r.thesis.primaryShare)} against the thesis — ${verdict(
      r.thesis.primaryFails === null ? null : !r.thesis.primaryFails,
    )} (fails if ≥ 20%)`,
  );
  lines.push(
    `- SECONDARY (structural dollar route counted against): ${pct(r.thesis.secondaryShare)} against the thesis — ${verdict(
      r.thesis.secondaryFails === null ? null : !r.thesis.secondaryFails,
    )} (fails if ≥ 20%)`,
  );
  if (r.thesis.untagged.length > 0)
    lines.push(`- UNTAGGED, excluded from both shares: ${r.thesis.untagged.join(", ")}`);
  lines.push(
    "",
    "### Issuers' own AGU-lab income sales (code, not an agent's choice; reported separately, never scored into the thesis)",
    "",
  );
  if (r.issuerExits.length === 0) lines.push("- none");
  for (const e of r.issuerExits)
    lines.push(
      `- window ${e.window} ${e.issuer}: ${e.agu} AGU-lab base units → ${e.usdc} USDC base units; ${e.payers.length} payment(s) in, hops ${e.payers.map((p) => p.hops).join(",") || "none"}`,
    );
  lines.push(
    "",
    "### Circulation: received currency spent onward in at least half of opportunities (per currency: a receipt counts as spent onward only by a later payment in the same currency)",
    "",
  );
  lines.push(circulationLine(r.circulation.agu, "agu"), circulationLine(r.circulation.usdc, "usdc"));
  lines.push("", "### Buying ahead: the hedger and demand agents cover ≥ a quarter of the next window's known needs in most windows", "");
  for (const w of r.buyingAhead.perWindow)
    lines.push(`- window ${w.window} → ${w.window + 1}: ${w.covered} of ${w.total} covered (${pct(w.share)})`);
  lines.push(
    `- ${r.buyingAhead.windowsAtLeastQuarter} of ${r.buyingAhead.windowsConsidered} windows at or above a quarter — ${verdict(r.buyingAhead.holds)}`,
  );
  const u = r.buyingAhead.actionsByUnit;
  lines.push(
    `- buying-ahead actions by payment currency: AGU-lab ${u.agu}, USDC ${u.usdc}${u.unrecorded > 0 ? `, not recorded ${u.unrecorded}` : ""}`,
  );
  lines.push("", "### Comparability: with SIU shown first, the cheapest passing offer is picked more often than with dollars first", "");
  lines.push(
    `- SIU first: ${pct(r.comparability.siuFirstCheapestShare)} of ${r.comparability.siuFirstSample} real choices; dollars first: ${pct(r.comparability.dollarsFirstCheapestShare)} of ${r.comparability.dollarsFirstSample} — ${verdict(r.comparability.holds)}`,
  );
  const p = r.comparability.acceptedPaidIn;
  lines.push(`- accepted offers in the sample, by what paid for them: AGU-lab ${p.agu}, USDC ${p.usdc}, work claims ${p.claims}`);
  lines.push("", "### Kill criteria: any two close the currency question for this design", "");
  const k = r.killCriteria;
  lines.push(
    `- 1. near-universal conversion to USDC on receipt (≥ 90%, a pre-registered proxy threshold): ${conversionText(k.conversionOnReceipt.agu, "agu")}; ${conversionText(k.conversionOnReceipt.usdc, "usdc")} — ${k.conversionOnReceipt.agu.fails ? "FIRES" : "does not fire"} (scored on AGU-lab)`,
  );
  lines.push(
    `- 2. median hops stays at one: ${hopsText(k.medianHops.agu, "agu")}; ${hopsText(k.medianHops.usdc, "usdc")} — ${k.medianHops.agu.fails ? "FIRES" : "does not fire"} (scored on AGU-lab)`,
  );
  const qd = k.quotingInDollars;
  lines.push(
    `- 3. quoting in dollars when free to choose (a dollar amount in an agent's own message): ${qd.messages === 0 ? "n/a (no messages)" : `${qd.count} of ${qd.messages} messages`}; binding quotes posted: ${qd.bindingQuotesByUnit.siu} in mSIU, ${qd.bindingQuotesByUnit.usdc} in USDC — ${qd.fails ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- 4. no demand agent ever bought ahead for a visible need: ${r.killCriteria.noBuyingAheadForVisibleNeeds ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- **${r.killCriteria.failCount} of 4 fired — ${r.killCriteria.fails ? "KILL CRITERION MET (two or more fired)" : "not met"}**`,
  );
  return `${lines.join("\n")}\n`;
}
