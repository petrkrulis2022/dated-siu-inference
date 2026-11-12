/**
 * The economy's parameters (`docs/part5-build-plan.md` §3.5): one committed file, `data/lab/cr/economy-params.json`, holding every number the economy uses. It is frozen before the first
 * counted window and never edited after (pre-registration, D87); until then its values are labelled illustrative. Amounts are integer base units read from strings, never floats.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { D, type DecimalValue } from "@touchstone/sdk";
import { CR_PUBLIC_DIR } from "../paths.js";
import type { TaskId } from "../tasks/instances.js";
import { TASKS } from "../tasks/instances.js";
import type { Grade } from "./cr-print.js";

export const PARAMS_PATH = join(CR_PUBLIC_DIR, "economy-params.json");

export interface IssuerParams {
  id: string;
  model: string;
  grade: Grade;
  classes: TaskId[];
  budgetUsdPerWindow: DecimalValue;
  bondUsdc: bigint;
  /** the published share of presentations this issuer fails (ISSUER-X), basis points */
  failShareBps: bigint;
  /**
   * v3a: the classes this issuer bonds claim lots for, when narrower than the classes it serves commissions in (ISSUER-F serves all four types but bonds CR-VS lots only,
   * so a Commodity reserve claim can never be routed to it). Absent: every class it serves.
   */
  lotClasses?: TaskId[];
  /** v3a: this issuer's list price as a share of its model's measured cost per pass, basis points (ISSUER-X lists 15% below C1/C2, D143). Absent: 10,000. */
  listPriceBps?: bigint;
  /** v3a: why this issuer is configured as it is, recorded with the config (the owner, D143) */
  reason?: string;
}

/** v3a (docs/experiment-3a-design.md): mandates differ only in cap size and buffer */
export type MandateProfile = "cautious" | "standard" | "permissive";
export interface V3aMandate {
  profile: MandateProfile;
  /** spend cap per window OF DELIVERY (the window the work is for, never the window of purchase), in reference briefs valued at the print */
  capBriefsPerWindow: number;
  /** the minimum total value (USDC, AGU-lab and claims, valued at the print) to keep after any spend, as a share of starting value, basis points */
  minValueBufferBps: bigint;
}

/** v3a's whole configuration beyond the shared engine parameters; present only in a v3a parameters file */
export interface V3aParams {
  note: string;
  windows: number;
  /** the PROVIDER model agent's id */
  provider: string;
  /** each role's starting USDC; every role starts with the same value again in AGU-lab, at the opening print (genesis converts at the participant's mid) */
  startingUsdc: { research: bigint; demand: bigint; hedger: bigint };
  mandates: Record<string, V3aMandate>;
  /** the owner's fixed dollar demand on each demand agent, at the end of these windows, as a share of its starting value (shown on the board from window 1, round 1) */
  sweep: { windows: number[]; shareOfStartingValueBps: bigint };
  needsVisibleWindows: number;
  printPath: {
    burnIn: number;
    lowVolPpm: bigint;
    highVolPpm: bigint;
    classNoisePpm: bigint;
    /** how the low setting was measured (source, ref, range, count) */
    lowVolMeasured: string;
    /** each counted cell's price-path seed, as `pricePathSeedHash`; the seeds stay hidden until the run ends */
    seedHashes: Record<string, string>;
  };
  passRates: { path: string; sha256: string };
  /** a failed task is paid for (true) or refunded in full (false, the design's rule) */
  failedWorkPays: boolean;
  /** a dataset's price in mSIU (about one task's value), payable in either currency */
  dataPriceMilli: bigint;
  armB: { holdShareBps: bigint; windowsAhead: number; agents: string[] };
  providerRules: {
    /** each default on a claim PROVIDER sold costs its SIU profit this share of the bond's payout */
    defaultPenaltyBps: bigint;
    discountMinBps: bigint;
    discountMaxBps: bigint;
    /** how far ahead PROVIDER may offer claims, in windows (0 = the current window) */
    maxWindowsAhead: number;
  };
  /** the least AGU-lab value (mSIU) an agent may redeem, and the least claim face it may create with */
  minRedeemMilli: bigint;
  minCreateMilli: bigint;
  seats: { counted: string; dev: string };
  /** each measure's own minimum count below which it reports n/a */
  minCounts: Record<string, number>;
}

export interface Mandate {
  usdc: bigint;
  spendLimitAguPerWindow: bigint;
  holdingCeilingDays: number;
  minUsdcBuffer: bigint;
  sweepDays: number[];
}

export interface EconomyParams {
  status: string;
  secondsPerWindow: number;
  roundsPerWindow: number;
  ladderWindows: number;
  reserve: {
    series: Grade;
    faceMilliPerWindow: bigint;
    minTenorSeconds: number;
    discountBps: bigint;
    bufferSeedUsdc: bigint;
    bufferTargetUsdc: bigint;
  };
  participant: { usdc: bigint; spreadBps: bigint; buybackCapBps: bigint };
  issuers: IssuerParams[];
  deliveryFloorBps: bigint;
  deliveryTrailingWindows: number;
  probeShareBps: bigint;
  probesToClear: number;
  dataShadowPriceUsdc: bigint;
  briefMarkupBps: bigint;
  agents: { research: string[]; demand: string[]; hedger: string; provider?: string };
  mandates: Record<string, Mandate>;
  researchUsdc: bigint;
  /** v2 item 8: `priceUsdcPerBrief` is the on-time delivery bonus (previously parsed and never read anywhere); `latePenaltyUsdcPerBrief` is new -- a stated penalty for each brief behind its own due schedule, or never delivered by the run's end */
  hedger: { usdc: bigint; briefsSold: number; priceUsdcPerBrief: bigint; latePenaltyUsdcPerBrief?: bigint };
  needsPerDemandAgentPerWindow: number;
  mirroredShareBps: bigint;
  spendCapUsdPerWindow: DecimalValue;
  seed: string;
  /** the counted windows, pre-registered with the rest of this file (D87): the stored days they run on, in order, the seats' models rotating by window, and how they settle */
  counted?: {
    days: string[];
    seats: string[];
    settlement: string;
    redemptionIsFinding: boolean;
    /** v2 fix freeze (owner, 2026-11-07): which data backend the counted run uses, recorded as a fact in the config itself, not just implied by whichever CLI flag happens to be passed */
    dataSource?: "stand-in" | "snapshot";
  };
  /** v2 item 8: a demand agent's stated cost for each need that lapses unmet -- ONE shared value across every demand agent, never per-agent, so the identical-pair noise control stays intact */
  unmetNeedCostMicroSiu?: bigint;
  /** v2 item 9: how many windows ahead a demand agent's own needs are visible; `board.ts`'s own default (2) applies when this is absent, for every v1 log/fixture that predates the field */
  forwardVisibilityWindows?: number;
  /** v2 item 10: the first real, published Dated SIU print date the stand-in replays from, one window per calendar day that has a print, in order */
  printHistoryStartDate?: string;
  /** v3a: present only in a v3a parameters file */
  v3a?: V3aParams;
}

const big = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^\d+$/.test(v))
    throw new Error(`economy params: ${what} must be a string of digits, got ${JSON.stringify(v)}`);
  return BigInt(v);
};
const dec = (v: unknown, what: string): DecimalValue => {
  if (typeof v !== "string" || !/^\d+(\.\d+)?$/.test(v))
    throw new Error(`economy params: ${what} must be a decimal string, got ${JSON.stringify(v)}`);
  return new D(v);
};

type Raw = Record<string, unknown> & {
  reserve: Record<string, unknown>;
  participant: Record<string, unknown>;
  issuers: Record<string, unknown>[];
  agents: EconomyParams["agents"];
  mandates: Record<string, Record<string, unknown>>;
  hedger: Record<string, unknown>;
};

export function parseParams(raw: Raw): EconomyParams {
  const issuers = raw.issuers.map((i, n): IssuerParams => {
    const classes = i.classes as TaskId[];
    for (const c of classes)
      if (!TASKS.includes(c)) throw new Error(`economy params: issuer ${n} has unknown class ${c}`);
    const lotClasses = i.lotClasses === undefined ? undefined : (i.lotClasses as TaskId[]);
    for (const c of lotClasses ?? [])
      if (!classes.includes(c)) throw new Error(`economy params: issuer ${n} bonds a ${c} lot for a class it does not serve`);
    return {
      id: String(i.id),
      model: String(i.model),
      grade: i.grade as Grade,
      classes,
      budgetUsdPerWindow: dec(i.budgetUsdPerWindow, `issuers[${n}].budgetUsdPerWindow`),
      bondUsdc: big(i.bondUsdc, `issuers[${n}].bondUsdc`),
      failShareBps: big(i.failShareBps, `issuers[${n}].failShareBps`),
      ...(lotClasses !== undefined ? { lotClasses } : {}),
      ...(i.listPriceBps !== undefined ? { listPriceBps: big(i.listPriceBps, `issuers[${n}].listPriceBps`) } : {}),
      ...(i.reason !== undefined ? { reason: String(i.reason) } : {}),
    };
  });
  const mandates: Record<string, Mandate> = {};
  for (const [id, m] of Object.entries(raw.mandates))
    mandates[id] = {
      usdc: big(m.usdc, `${id}.usdc`),
      spendLimitAguPerWindow: big(m.spendLimitAguPerWindow, `${id}.spendLimitAguPerWindow`),
      holdingCeilingDays: Number(m.holdingCeilingDays),
      minUsdcBuffer: big(m.minUsdcBuffer, `${id}.minUsdcBuffer`),
      sweepDays: (m.sweepDays as number[]).map(Number),
    };
  const v3a = raw.v3a === undefined ? undefined : parseV3a(raw.v3a as Record<string, unknown>);
  for (const d of raw.agents.demand)
    if (mandates[d] === undefined && v3a?.mandates[d] === undefined) throw new Error(`economy params: no mandate for ${d}`);
  if (raw.reserve.series !== "commodity" && raw.reserve.series !== "frontier")
    throw new Error("economy params: reserve.series");
  // routing picks an issuer by task type, not by grade: an issuer of another grade holding a lot of a class the reserve's grade serves
  // would be routed reserve claims (found 2026-11-04, when ISSUER-F had a CR-PL lot). v3a: only the classes an issuer bonds LOTS for can be routed claims, so the check is
  // on those (ISSUER-F serves CR-PL by commission but bonds no CR-PL lot)
  for (const i of issuers)
    if (i.grade !== raw.reserve.series)
      for (const c of i.lotClasses ?? i.classes)
        if (issuers.some((j) => j.grade === raw.reserve.series && (j.lotClasses ?? j.classes).includes(c)))
          throw new Error(
            `economy params: ${i.id} (${i.grade}) has a ${c} lot, a class the ${raw.reserve.series} issuers serve, so reserve claims could be routed to it`,
          );
  return {
    status: String(raw.status),
    secondsPerWindow: Number(raw.secondsPerWindow),
    roundsPerWindow: Number(raw.roundsPerWindow),
    ladderWindows: Number(raw.ladderWindows),
    reserve: {
      series: raw.reserve.series,
      faceMilliPerWindow: big(raw.reserve.faceMilliPerWindow, "reserve.faceMilliPerWindow"),
      minTenorSeconds: Number(raw.reserve.minTenorSeconds),
      discountBps: big(raw.reserve.discountBps, "reserve.discountBps"),
      bufferSeedUsdc: big(raw.reserve.bufferSeedUsdc, "reserve.bufferSeedUsdc"),
      bufferTargetUsdc: big(raw.reserve.bufferTargetUsdc, "reserve.bufferTargetUsdc"),
    },
    participant: {
      usdc: big(raw.participant.usdc, "participant.usdc"),
      spreadBps: big(raw.participant.spreadBps, "participant.spreadBps"),
      buybackCapBps: big(raw.participant.buybackCapBps, "participant.buybackCapBps"),
    },
    issuers,
    deliveryFloorBps: big(raw.deliveryFloorBps, "deliveryFloorBps"),
    deliveryTrailingWindows: Number(raw.deliveryTrailingWindows),
    probeShareBps: big(raw.probeShareBps, "probeShareBps"),
    probesToClear: Number(raw.probesToClear),
    dataShadowPriceUsdc: big(raw.dataShadowPriceUsdc, "dataShadowPriceUsdc"),
    briefMarkupBps: big(raw.briefMarkupBps, "briefMarkupBps"),
    agents: raw.agents,
    mandates,
    researchUsdc: big(raw.researchUsdc, "researchUsdc"),
    hedger: {
      usdc: big(raw.hedger.usdc, "hedger.usdc"),
      briefsSold: Number(raw.hedger.briefsSold),
      priceUsdcPerBrief: big(raw.hedger.priceUsdcPerBrief, "hedger.priceUsdcPerBrief"),
      ...(raw.hedger.latePenaltyUsdcPerBrief !== undefined
        ? { latePenaltyUsdcPerBrief: big(raw.hedger.latePenaltyUsdcPerBrief, "hedger.latePenaltyUsdcPerBrief") }
        : {}),
    },
    needsPerDemandAgentPerWindow: Number(raw.needsPerDemandAgentPerWindow),
    mirroredShareBps: big(raw.mirroredShareBps, "mirroredShareBps"),
    spendCapUsdPerWindow: dec(raw.spendCapUsdPerWindow, "spendCapUsdPerWindow"),
    seed: String(raw.seed),
    ...(raw.counted !== undefined ? { counted: parseCounted(raw.counted) } : {}),
    ...(raw.unmetNeedCostMicroSiu !== undefined
      ? { unmetNeedCostMicroSiu: big(raw.unmetNeedCostMicroSiu, "unmetNeedCostMicroSiu") }
      : {}),
    ...(raw.forwardVisibilityWindows !== undefined
      ? { forwardVisibilityWindows: Number(raw.forwardVisibilityWindows) }
      : {}),
    ...(raw.printHistoryStartDate !== undefined
      ? { printHistoryStartDate: String(raw.printHistoryStartDate) }
      : {}),
    ...(v3a !== undefined ? { v3a } : {}),
  };
}

const int = (v: unknown, what: string): bigint => {
  if (typeof v !== "string" || !/^-?\d+$/.test(v))
    throw new Error(`economy params: ${what} must be a string of digits, got ${JSON.stringify(v)}`);
  return BigInt(v);
};

function parseV3a(r: Record<string, unknown>): V3aParams {
  const o = (v: unknown, what: string): Record<string, unknown> => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`economy params: v3a.${what} must be an object`);
    return v as Record<string, unknown>;
  };
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`economy params: v3a.${what} must be a whole number`);
    return v;
  };
  const start = o(r.startingUsdc, "startingUsdc");
  const mandates: Record<string, V3aMandate> = {};
  for (const [id, m] of Object.entries(o(r.mandates, "mandates"))) {
    const x = o(m, `mandates.${id}`);
    if (x.profile !== "cautious" && x.profile !== "standard" && x.profile !== "permissive")
      throw new Error(`economy params: v3a.mandates.${id}.profile`);
    mandates[id] = {
      profile: x.profile,
      capBriefsPerWindow: num(x.capBriefsPerWindow, `mandates.${id}.capBriefsPerWindow`),
      minValueBufferBps: big(x.minValueBufferBps, `v3a.mandates.${id}.minValueBufferBps`),
    };
  }
  const sweep = o(r.sweep, "sweep");
  const path = o(r.printPath, "printPath");
  const pr = o(r.passRates, "passRates");
  const b = o(r.armB, "armB");
  const p = o(r.providerRules, "providerRules");
  const seats = o(r.seats, "seats");
  const seedHashes = o(path.seedHashes, "printPath.seedHashes");
  return {
    note: String(r.note),
    windows: num(r.windows, "windows"),
    provider: String(r.provider),
    startingUsdc: {
      research: big(start.research, "v3a.startingUsdc.research"),
      demand: big(start.demand, "v3a.startingUsdc.demand"),
      hedger: big(start.hedger, "v3a.startingUsdc.hedger"),
    },
    mandates,
    sweep: {
      windows: (sweep.windows as unknown[]).map((w) => num(w, "sweep.windows")),
      shareOfStartingValueBps: big(sweep.shareOfStartingValueBps, "v3a.sweep.shareOfStartingValueBps"),
    },
    needsVisibleWindows: num(r.needsVisibleWindows, "needsVisibleWindows"),
    printPath: {
      burnIn: num(path.burnIn, "printPath.burnIn"),
      lowVolPpm: big(path.lowVolPpm, "v3a.printPath.lowVolPpm"),
      highVolPpm: big(path.highVolPpm, "v3a.printPath.highVolPpm"),
      classNoisePpm: big(path.classNoisePpm, "v3a.printPath.classNoisePpm"),
      lowVolMeasured: String(path.lowVolMeasured),
      seedHashes: Object.fromEntries(Object.entries(seedHashes).map(([k, v]) => [k, String(v)])),
    },
    passRates: { path: String(pr.path), sha256: String(pr.sha256) },
    failedWorkPays: r.failedWorkPays === true,
    dataPriceMilli: big(r.dataPriceMilli, "v3a.dataPriceMilli"),
    armB: {
      holdShareBps: big(b.holdShareBps, "v3a.armB.holdShareBps"),
      windowsAhead: num(b.windowsAhead, "armB.windowsAhead"),
      agents: (b.agents as unknown[]).map(String),
    },
    providerRules: {
      defaultPenaltyBps: big(p.defaultPenaltyBps, "v3a.providerRules.defaultPenaltyBps"),
      discountMinBps: int(p.discountMinBps, "v3a.providerRules.discountMinBps"),
      discountMaxBps: int(p.discountMaxBps, "v3a.providerRules.discountMaxBps"),
      maxWindowsAhead: num(p.maxWindowsAhead, "providerRules.maxWindowsAhead"),
    },
    minRedeemMilli: big(r.minRedeemMilli, "v3a.minRedeemMilli"),
    minCreateMilli: big(r.minCreateMilli, "v3a.minCreateMilli"),
    seats: { counted: String(seats.counted), dev: String(seats.dev) },
    minCounts: Object.fromEntries(Object.entries(o(r.minCounts, "minCounts")).map(([k, v]) => [k, num(v, `minCounts.${k}`)])),
  };
}

function parseCounted(v: unknown): NonNullable<EconomyParams["counted"]> {
  const c = v as Record<string, unknown>;
  const days = c.days as unknown[];
  const seats = c.seats as unknown[];
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    !days.every((d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))
  )
    throw new Error("economy params: counted.days must be a list of dates");
  if (!Array.isArray(seats) || seats.length === 0 || !seats.every((x) => typeof x === "string"))
    throw new Error("economy params: counted.seats must be a list of model ids");
  if (c.dataSource !== undefined && c.dataSource !== "stand-in" && c.dataSource !== "snapshot")
    throw new Error('economy params: counted.dataSource must be "stand-in" or "snapshot"');
  return {
    days: days as string[],
    seats: seats as string[],
    settlement: String(c.settlement),
    redemptionIsFinding: c.redemptionIsFinding === true,
    ...(c.dataSource !== undefined ? { dataSource: c.dataSource } : {}),
  };
}

export function loadParams(path: string = PARAMS_PATH): EconomyParams {
  return parseParams(JSON.parse(readFileSync(path, "utf-8")) as Raw);
}
