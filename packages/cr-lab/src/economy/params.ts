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
  agents: { research: string[]; demand: string[]; hedger: string };
  mandates: Record<string, Mandate>;
  researchUsdc: bigint;
  /** v2 item 8: `priceUsdcPerBrief` is the on-time delivery bonus (previously parsed and never read anywhere); `latePenaltyUsdcPerBrief` is new -- a stated penalty for each brief behind its own due schedule, or never delivered by the run's end */
  hedger: { usdc: bigint; briefsSold: number; priceUsdcPerBrief: bigint; latePenaltyUsdcPerBrief?: bigint };
  needsPerDemandAgentPerWindow: number;
  mirroredShareBps: bigint;
  spendCapUsdPerWindow: DecimalValue;
  seed: string;
  /** the counted windows, pre-registered with the rest of this file (D87): the stored days they run on, in order, the seats' models rotating by window, and how they settle */
  counted?: { days: string[]; seats: string[]; settlement: string; redemptionIsFinding: boolean };
  /** v2 item 8: a demand agent's stated cost for each need that lapses unmet -- ONE shared value across every demand agent, never per-agent, so the identical-pair noise control stays intact */
  unmetNeedCostMicroSiu?: bigint;
  /** v2 item 9: how many windows ahead a demand agent's own needs are visible; `board.ts`'s own default (2) applies when this is absent, for every v1 log/fixture that predates the field */
  forwardVisibilityWindows?: number;
  /** v2 item 10: the first real, published Dated SIU print date the stand-in replays from, one window per calendar day that has a print, in order */
  printHistoryStartDate?: string;
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
    return {
      id: String(i.id),
      model: String(i.model),
      grade: i.grade as Grade,
      classes,
      budgetUsdPerWindow: dec(i.budgetUsdPerWindow, `issuers[${n}].budgetUsdPerWindow`),
      bondUsdc: big(i.bondUsdc, `issuers[${n}].bondUsdc`),
      failShareBps: big(i.failShareBps, `issuers[${n}].failShareBps`),
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
  for (const d of raw.agents.demand)
    if (mandates[d] === undefined) throw new Error(`economy params: no mandate for ${d}`);
  if (raw.reserve.series !== "commodity" && raw.reserve.series !== "frontier")
    throw new Error("economy params: reserve.series");
  // routing picks an issuer by task type, not by grade: an issuer of another grade holding a lot of a class the reserve's grade serves
  // would be routed reserve claims (found 2026-11-04, when ISSUER-F had a CR-PL lot)
  for (const i of issuers)
    if (i.grade !== raw.reserve.series)
      for (const c of i.classes)
        if (issuers.some((j) => j.grade === raw.reserve.series && j.classes.includes(c)))
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
  return {
    days: days as string[],
    seats: seats as string[],
    settlement: String(c.settlement),
    redemptionIsFinding: c.redemptionIsFinding === true,
  };
}

export function loadParams(path: string = PARAMS_PATH): EconomyParams {
  return parseParams(JSON.parse(readFileSync(path, "utf-8")) as Raw);
}
