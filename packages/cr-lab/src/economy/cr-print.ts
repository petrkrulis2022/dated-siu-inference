/**
 * WP0 of the Part 5 build plan (`docs/part5-build-plan.md` §4.1): the CR unit, each issuer model's cost per SIU and measured rate, the CR lab print per grade, and the haircut.
 *
 * THE UNIT. One CR-SIU is one verified correct answer to each of the four CR task types (the CR basket, versioned `SIU-CR-2026a`; CR-SM counts once, whichever dimension was drawn).
 *
 * COST PER SIU. Over a trailing set of days, the sum over the four task types of the model's headline cost on that type divided by its passes on that type. A type with no pass in the
 * window gives the model no cost per SIU, and it cannot issue until it has one. The headline cost is the cost under the frozen output allowance (D113, `headlineCost`), so the print does
 * not carry the cost of a cut-off first call; an answer whose headline cost cannot be derived honestly is left out of that type's cost and passes, and counted.
 *
 * THE PRINT. USD per CR-SIU for a grade is the mean cost per SIU of that grade's issuer models that have one, rounded once, at publication, half up, to nano-USD per SIU. List prices are
 * never an input (invariant 1): every figure is a billed cost from an executed answer.
 *
 * QUALIFICATION is separate from the cost (D119, read per task type since D124): a model issues claims only for the task types on which its pass rate is at least 80%. A model can have a
 * cost per SIU (one pass on every type) and still qualify on fewer than four types; claims for the others come from a model that does qualify.
 *
 * THE HAIRCUT (D92): budget divided by one plus the 95th-percentile rise in the issuer's own cost per SIU between consecutive days that both have one. The percentile is nearest-rank, so
 * with fewer than twenty rises it is the largest rise; a fall counts as a rise of zero. Few days stand behind it, and the result says how many.
 *
 * Only snapshot-mode answers count (D70): records of the parts `snapshot` and `dry-run` (the dry runs are snapshot-mode answers on stored days); MCP sessions never do.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import { headlineCost } from "../runner/allowance.js";
import type { ModelPrice } from "../runner/prices.js";
import type { AnswerRecord } from "../runner/records.js";
import { TASKS, type TaskId } from "../tasks/instances.js";

export const CR_BASKET_VERSION = "SIU-CR-2026a" as const;
export type Grade = "frontier" | "commodity";
/** D119: the pass rate a model needs on a task type to issue claims for it. */
export const QUALIFYING_PASS_RATE = new D("0.8");
const SNAPSHOT_PARTS: ReadonlySet<AnswerRecord["part"]> = new Set(["snapshot", "dry-run"]);

export interface TypeResult {
  task: TaskId;
  answers: number;
  passes: number;
  /** headline cost of the counted answers, USD */
  costUsd: DecimalValue;
  /** answers left out because their headline cost could not be derived */
  notDerivable: number;
  /** passes ÷ answers; undefined with no answer */
  passRate?: DecimalValue;
  qualified: boolean;
}

export interface ModelCost {
  model: string;
  grade: Grade;
  days: string[];
  perType: Record<TaskId, TypeResult>;
  /** USD per CR-SIU; undefined when some type has no pass */
  costPerSiu?: DecimalValue;
  /** accepted SIU per USD = 1 ÷ cost per SIU */
  measuredRate?: DecimalValue;
  /** the task types it may issue claims for */
  qualifiedTasks: TaskId[];
}

/** One model's cost per SIU, measured rate and qualification over `days`, from its snapshot-mode records. */
export function modelCost(
  records: readonly AnswerRecord[],
  model: string,
  grade: Grade,
  days: readonly string[],
  price: ModelPrice,
): ModelCost {
  const inDays = new Set(days);
  const mine = records.filter(
    (r) => r.model === model && SNAPSHOT_PARTS.has(r.part) && inDays.has(r.window),
  );
  const perType = {} as Record<TaskId, TypeResult>;
  for (const task of TASKS) {
    let answers = 0;
    let passes = 0;
    let notDerivable = 0;
    let costUsd = new D(0);
    for (const r of mine.filter((x) => x.task === task)) {
      const b = headlineCost(r, price);
      if (!b.derivable) {
        notDerivable++;
        continue;
      }
      answers++;
      if (b.passed) passes++;
      costUsd = costUsd.plus(b.usd);
    }
    const passRate = answers > 0 ? new D(passes).div(answers) : undefined;
    perType[task] = {
      task,
      answers,
      passes,
      costUsd,
      notDerivable,
      ...(passRate !== undefined ? { passRate } : {}),
      qualified: passRate !== undefined && passRate.gte(QUALIFYING_PASS_RATE),
    };
  }
  const hasCost = TASKS.every((t) => perType[t].passes > 0);
  const costPerSiu = hasCost
    ? TASKS.reduce((sum, t) => sum.plus(perType[t].costUsd.div(perType[t].passes)), new D(0))
    : undefined;
  return {
    model,
    grade,
    days: [...days].sort(),
    perType,
    ...(costPerSiu !== undefined ? { costPerSiu } : {}),
    ...(costPerSiu !== undefined && costPerSiu.gt(0)
      ? { measuredRate: new D(1).div(costPerSiu) }
      : {}),
    qualifiedTasks: TASKS.filter((t) => perType[t].qualified),
  };
}

export interface CrPrint {
  basket: typeof CR_BASKET_VERSION;
  grade: Grade;
  days: string[];
  /** the issuer models whose cost per SIU went into the mean */
  issuers: string[];
  /** issuer models of the grade left out because they have no cost per SIU */
  withoutCost: string[];
  /** undefined when no issuer of the grade has a cost per SIU: then the grade has no print */
  usdPerSiu?: string;
  nanoUsdPerSiu?: bigint;
}

/** The CR lab print for one grade: the mean of its issuers' costs per SIU, rounded once, half up, to nano-USD. */
export function crPrint(costs: readonly ModelCost[], grade: Grade): CrPrint {
  const ofGrade = costs.filter((c) => c.grade === grade);
  const withCost = ofGrade.filter((c) => c.costPerSiu !== undefined);
  const days = [...new Set(ofGrade.flatMap((c) => c.days))].sort();
  const base = {
    basket: CR_BASKET_VERSION,
    grade,
    days,
    issuers: withCost.map((c) => c.model),
    withoutCost: ofGrade.filter((c) => c.costPerSiu === undefined).map((c) => c.model),
  };
  if (withCost.length === 0) return base;
  const mean = withCost
    .reduce((s, c) => s.plus(c.costPerSiu as DecimalValue), new D(0))
    .div(withCost.length);
  const nano = mean.times(1_000_000_000).toDecimalPlaces(0, D.ROUND_HALF_UP);
  return {
    ...base,
    usdPerSiu: nano.div(1_000_000_000).toFixed(9),
    nanoUsdPerSiu: BigInt(nano.toFixed(0)),
  };
}

export interface Haircut {
  /** consecutive days that both had a cost per SIU */
  pairs: number;
  /** the rises, as fractions (0.1 = 10%), falls counted as 0 */
  rises: DecimalValue[];
  /** nearest-rank 95th percentile of `rises`; 0 with no pair */
  p95Rise: DecimalValue;
  /** budget ÷ (1 + p95Rise), USD */
  budgetAfterHaircutUsd: DecimalValue;
}

/** The haircut on `budgetUsd` from a model's per-day costs per SIU, in day order. A day without a cost breaks the chain: only consecutive days that both have one make a pair. */
export function haircut(
  daily: readonly { day: string; costPerSiu?: DecimalValue }[],
  budgetUsd: DecimalValue | string,
): Haircut {
  const sorted = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const rises: DecimalValue[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]?.costPerSiu;
    const cur = sorted[i]?.costPerSiu;
    if (prev === undefined || cur === undefined || prev.lte(0)) continue;
    if (!consecutive(sorted[i - 1]?.day as string, sorted[i]?.day as string)) continue;
    const rise = cur.div(prev).minus(1);
    rises.push(rise.gt(0) ? rise : new D(0));
  }
  const ordered = [...rises].sort((a, b) => a.comparedTo(b));
  const rank = Math.ceil(0.95 * ordered.length);
  const p95Rise = ordered.length === 0 ? new D(0) : (ordered[rank - 1] as DecimalValue);
  return {
    pairs: rises.length,
    rises,
    p95Rise,
    budgetAfterHaircutUsd: new D(budgetUsd).div(new D(1).plus(p95Rise)),
  };
}

function consecutive(a: string, b: string): boolean {
  const next = new Date(`${a}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10) === b;
}

/** Each day's cost per SIU for one model (undefined on a day where some type had no pass), for the haircut. */
export function dailyCosts(
  records: readonly AnswerRecord[],
  model: string,
  grade: Grade,
  days: readonly string[],
  price: ModelPrice,
): { day: string; costPerSiu?: DecimalValue }[] {
  return days.map((day) => {
    const c = modelCost(records, model, grade, [day], price);
    return c.costPerSiu !== undefined ? { day, costPerSiu: c.costPerSiu } : { day };
  });
}
