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
import type { LogEntry } from "./log.js";
import type { EconomyParams } from "./params.js";
import { reasoningBeforeOf } from "./overview.js";
import { needsSchedule } from "./runner.js";
import { AGU_ISSUER } from "./world.js";

export type ExitClass = "structural dollar route" | "dollar cost" | "price move" | "fear" | "other";
const BLIND_TAGGED: readonly ExitClass[] = ["dollar cost", "price move", "fear", "other"];

/**
 * A log field holding an amount is a live `bigint` only inside the SAME process that ran the window; once the log is written to disk and read back (every stored run this
 * module is meant to score, `economy-score.ts`'s whole reason to exist), `log.ts`'s own replacer has turned every bigint into a plain decimal string. This reads either
 * back as the same `bigint`, so every function below works identically on a live log and a stored one.
 */
function asBigInt(v: unknown): bigint | undefined {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
}

/** the log's own window (a day label) in run order, mapped back to the numeric window index 1..N every other part of the engine uses */
export function windowIndexOf(log: readonly LogEntry[]): Map<string, number> {
  const order: string[] = [];
  for (const e of log) if (!order.includes(e.window)) order.push(e.window);
  return new Map(order.map((d, i) => [d, i + 1]));
}

const modelAgentIds = (params: EconomyParams): ReadonlySet<string> =>
  new Set([...params.agents.research, ...params.agents.demand, params.agents.hedger]);

/** the fixed prefix on `order_front_claim`'s own synthetic "message" entry (`world.ts`'s `#act`), so it is never mistaken for an agent's own free-text message */
const FRONT_ORDER_PREFIX = "front-claim order: ";
const FRONT_ORDER_TASK = /^front-claim order: [\d.]+ SIU of (\S+) for the next window$/;

/** every `(agent, forWindow)` pair with a buying-ahead action: an `order_front_claim` (the synthetic message) or a `buy_claims` (the `claim-mint` entry) */
function buyingAheadActions(log: readonly LogEntry[]): { agent: string; task: string | undefined; forWindow: number }[] {
  const dayIndex = windowIndexOf(log);
  const out: { agent: string; task: string | undefined; forWindow: number }[] = [];
  for (const e of log) {
    if (
      e.kind === "message" &&
      e.to === AGU_ISSUER &&
      typeof e.text === "string" &&
      e.text.startsWith(FRONT_ORDER_PREFIX)
    ) {
      const k = dayIndex.get(e.window);
      const m = FRONT_ORDER_TASK.exec(e.text);
      if (k !== undefined) out.push({ agent: e.actor, task: m?.[1], forWindow: k + 1 });
    }
    if (e.kind === "claim-mint")
      out.push({ agent: e.actor, task: e.task as string, forWindow: e.forWindow as number });
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
  const opens = log.filter((e) => e.kind === "escrow-open");
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

/** every AGU-lab receipt (an escrow paid to a model agent, never an issuer or the gate runner), and whether that agent is later seen paying onward or exiting to USDC */
function modelAgentReceipts(log: readonly LogEntry[], params: EconomyParams): ReceiptFact[] {
  const agents = modelAgentIds(params);
  const opens = log.filter((e) => e.kind === "escrow-open");
  const settles = log.filter((e) => e.kind === "escrow-settle" && (asBigInt(e.paid) ?? 0n) > 0n);
  const openByEscrow = new Map(opens.map((o) => [o.escrow as string, o]));
  const out: ReceiptFact[] = [];
  for (const s of settles) {
    const open = openByEscrow.get(s.escrow as string);
    if (open === undefined) continue;
    const seller = open.to as string;
    if (!agents.has(seller)) continue;
    out.push({
      onward: opens.some((o) => o.actor === seller && o.seq > s.seq),
      convertedToUsdc: log.some((e) => e.kind === "exit" && e.actor === seller && e.seq > s.seq),
    });
  }
  return out;
}

export interface CirculationScoring {
  onwardSpends: number;
  opportunities: number;
  share: number | null;
  holds: boolean | null;
}

/** "received currency is spent onward in at least half of opportunities" (§16.9); model agents only — an issuer's income sale is never a "receipt of currency" by an agent */
export function scoreCirculation(log: readonly LogEntry[], params: EconomyParams): CirculationScoring {
  const receipts = modelAgentReceipts(log, params);
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
}

/** kill criterion 1: "agents convert received currency to USDC almost every time"; the 90% threshold is pre-registered here, as the module's own doc comment explains */
export function scoreConversionToUsdc(log: readonly LogEntry[], params: EconomyParams): ConversionScoring {
  const receipts = modelAgentReceipts(log, params);
  const converted = receipts.filter((r) => r.convertedToUsdc).length;
  const share = receipts.length === 0 ? null : converted / receipts.length;
  return { converted, opportunities: receipts.length, share, fails: share !== null && share >= 0.9 };
}

export interface HopsScoring {
  values: number[];
  median: number | null;
  fails: boolean;
}

/** kill criterion 2: "median hops stays at one" (the per-receipt floor this module's doc comment explains; 1 = money stopped with this agent, 2 = it was seen paid onward) */
export function scoreHops(log: readonly LogEntry[], params: EconomyParams): HopsScoring {
  const values = modelAgentReceipts(log, params).map((r) => (r.onward ? 2 : 1));
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
}

/** "the hedger and demand agents cover at least a quarter of the next window's known needs in most windows" (§16.9) */
export function scoreBuyingAhead(log: readonly LogEntry[], params: EconomyParams): BuyingAheadScoring {
  const dayIndex = windowIndexOf(log);
  const windowCount = dayIndex.size;
  const needsFor = needsSchedule(params.seed, TASKS.filter((t): t is TaskId => t !== "CR-VS"));
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
  return {
    perWindow,
    windowsConsidered,
    windowsAtLeastQuarter,
    holds: windowsConsidered === 0 ? null : windowsAtLeastQuarter * 2 > windowsConsidered,
    neverCovered: perWindow.every((w) => w.covered === 0),
  };
}

export interface ComparabilityScoring {
  siuFirstCheapestShare: number | null;
  dollarsFirstCheapestShare: number | null;
  siuFirstSample: number;
  dollarsFirstSample: number;
  holds: boolean | null;
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
  const accepts = log.filter((e) => e.kind === "escrow-open" && typeof e.quote === "string");
  const passed = new Set(
    log.filter((e) => e.kind === "gate" && e.brief !== undefined && e.passed === true).map((e) => e.brief as string),
  );
  let siuN = 0;
  let siuCheapest = 0;
  let dollarsN = 0;
  let dollarsCheapest = 0;
  for (const acc of accepts) {
    const q = quotes.get(acc.quote as string);
    if (q === undefined || !passed.has(acc.quote as string)) continue;
    const alternatives = [...quotes.values()].filter((x) => x.need === q.need && x.seq < acc.seq);
    if (alternatives.length < 2) continue;
    const cheapest = alternatives.reduce((m, x) => (x.priceMicroSiu < m ? x.priceMicroSiu : m), alternatives[0]?.priceMicroSiu ?? 0n);
    const pickedCheapest = q.priceMicroSiu <= cheapest;
    const k = dayIndex.get(acc.window);
    if (k === undefined) continue;
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
  };
}

/** a dollar amount in an agent's own free text: "$12", "12 USD" or "12 USDC" — never a case `post_quote`'s schema can produce (kill criterion 3's proxy) */
const DOLLAR_IN_TEXT = /\$\s?\d|\b\d[\d,]*(?:\.\d+)?\s*(?:usd|usdc)\b/i;

export interface QuotingInDollars {
  count: number;
  messages: number;
  share: number | null;
  fails: boolean;
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
  return { count, messages: messages.length, share, fails: share !== null && share > 0 };
}

export interface KillCriteria {
  conversionOnReceipt: ConversionScoring;
  medianHops: HopsScoring;
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
): KillCriteria {
  const conversionOnReceipt = scoreConversionToUsdc(log, params);
  const medianHops = scoreHops(log, params);
  const quotingInDollars = scoreQuotingInDollars(log, params);
  const noBuyingAheadForVisibleNeeds = buyingAhead.neverCovered;
  const failCount = [
    conversionOnReceipt.fails,
    medianHops.fails,
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
  circulation: CirculationScoring;
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
    circulation: scoreCirculation(log, params),
    buyingAhead,
    comparability: scoreComparability(log),
    killCriteria: scoreKillCriteria(log, params, buyingAhead),
  };
}

const pct = (x: number | null): string => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const verdict = (ok: boolean | null): string => (ok === null ? "n/a (no sample)" : ok ? "HOLDS" : "DOES NOT HOLD");

export function renderScoringReport(r: ScoringReport): string {
  const lines: string[] = ["## Pre-registered scoring (§16.9)", ""];
  lines.push("### Thesis: agents exit only for sweeps and dollar costs", "");
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
  lines.push("", "### Circulation: received currency spent onward in at least half of opportunities", "");
  lines.push(
    `- ${r.circulation.onwardSpends} of ${r.circulation.opportunities} receipts spent onward (${pct(r.circulation.share)}) — ${verdict(r.circulation.holds)}`,
  );
  lines.push("", "### Buying ahead: the hedger and demand agents cover ≥ a quarter of the next window's known needs in most windows", "");
  for (const w of r.buyingAhead.perWindow)
    lines.push(`- window ${w.window} → ${w.window + 1}: ${w.covered} of ${w.total} covered (${pct(w.share)})`);
  lines.push(
    `- ${r.buyingAhead.windowsAtLeastQuarter} of ${r.buyingAhead.windowsConsidered} windows at or above a quarter — ${verdict(r.buyingAhead.holds)}`,
  );
  lines.push("", "### Comparability: with SIU shown first, the cheapest passing offer is picked more often than with dollars first", "");
  lines.push(
    `- SIU first: ${pct(r.comparability.siuFirstCheapestShare)} of ${r.comparability.siuFirstSample} real choices; dollars first: ${pct(r.comparability.dollarsFirstCheapestShare)} of ${r.comparability.dollarsFirstSample} — ${verdict(r.comparability.holds)}`,
  );
  lines.push("", "### Kill criteria: any two close the currency question for this design", "");
  lines.push(
    `- 1. near-universal conversion to USDC on receipt (≥ 90%, a pre-registered proxy threshold): ${pct(r.killCriteria.conversionOnReceipt.share)} — ${r.killCriteria.conversionOnReceipt.fails ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- 2. median hops stays at one: ${r.killCriteria.medianHops.median ?? "n/a"} (${r.killCriteria.medianHops.values.length} receipts) — ${r.killCriteria.medianHops.fails ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- 3. quoting in dollars when free to choose (a dollar amount in an agent's own message): ${r.killCriteria.quotingInDollars.count} of ${r.killCriteria.quotingInDollars.messages} messages — ${r.killCriteria.quotingInDollars.fails ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- 4. no demand agent ever bought ahead for a visible need: ${r.killCriteria.noBuyingAheadForVisibleNeeds ? "FIRES" : "does not fire"}`,
  );
  lines.push(
    `- **${r.killCriteria.failCount} of 4 fired — ${r.killCriteria.fails ? "KILL CRITERION MET (two or more fired)" : "not met"}**`,
  );
  return `${lines.join("\n")}\n`;
}
