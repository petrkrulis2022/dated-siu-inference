/**
 * The reference solvers (§16.6): from a day's snapshot to the answer key, in decimals, by rules written here and nowhere else. A model's answer is compared with these;
 * anything a solver cannot compute honestly returns `undefined` and the instance is not offered, rather than guessing.
 *
 * Definitions that the tasks depend on (each is also a decision in the plan):
 *  - A figure the source holds as null contributes nothing to a sum and is never read as zero. CR-PL needs EVERY day of its quarter present, so a protocol with a gap is not offered.
 *  - Months are calendar months in UTC, summed from the daily points that fall in them.
 *  - CR-PL's "payout to depositors and liquidity providers" is interest minus net interest income (D89): the identity fees - revenue = interest - net interest income held on
 *    every day calibrated, so the three figures agree; whether Blockworks means exactly this is question 2 in §16.12.
 *  - CR-UO's "next 30 days" is the 30 daily snapshots beginning with the snapshot day, and "next 90 days" the first 90; the percentage is of the circulating supply on the snapshot day.
 *  - CR-SM ranks by the absolute change in circulating supply in USD between 90 days before the snapshot day and the latest day the series reaches (the snapshot day, or the day before:
 *    Blockworks publishes with a one-day lag), among chains or among issuers.
 *    That figure is price-valued by Blockworks, so a stablecoin that falls below one dollar shows as a fall; the task states it.
 * Results are rounded to 6 decimals, half up, only here at the end (invariant 4).
 */
import { D, roundHalfUp, type DecimalValue } from "@touchstone/sdk";
import {
  addDays,
  completeMonthsWindow,
  daysBetween,
  monthsBefore,
  monthsOf,
  quarterWindow,
} from "../data-desk/dates.js";
import { MAX_PUBLICATION_LAG_DAYS, quarterStart } from "../data-desk/snapshot-plan.js";
import type { DayData } from "./day-data.js";

export const DP = 6;
const fmt = (x: DecimalValue): string => roundHalfUp(x, DP);

// ---- CR-VS: perp DEX volume share --------------------------------------------------------------------------------------------------------------
export interface VSReference {
  /** the five venues with the largest volume over the twelve months, largest first */
  venues: string[];
  /** the twelve months, oldest first, as `YYYY-MM` */
  months: string[];
  /** month -> venue -> that venue's share of the five's combined volume that month, in percent */
  shares: Record<string, Record<string, string>>;
}

/** A month count in words, for prompts and messages. */
export const monthsWord = (n: number): string =>
  ({ 1: "one", 2: "two", 3: "three", 6: "six", 12: "twelve" })[n] ?? String(n);

/** The end months a CR-VS instance can ask for: the last complete month and up to five before it (the plan pulls 17 months). */
export function vsEndMonths(window: string): string[] {
  const first = completeMonthsWindow(window, 1).end;
  return Array.from({ length: 6 }, (_, k) => monthsBefore(first, k));
}

/**
 * Each venue's volume in each of the twelve calendar months before `endMonth` (UTC), summed from its daily points; a null day adds nothing, and a venue with no
 * figure at all in the twelve months is left out. The solver ranks these sums, and the snapshot-mode prompt shows the same sums, so the two cannot disagree.
 */
export function vsMonthly(
  day: DayData,
  endMonth: string,
  nMonths = 12,
): { months: ReturnType<typeof monthsOf>; venues: Map<string, DecimalValue[]> } {
  const months = monthsOf(monthsBefore(endMonth, nMonths), endMonth);
  const venues = new Map<string, DecimalValue[]>();
  for (const [venue, points] of day.perp) {
    let anyPoint = false;
    const sums = months.map((m) => {
      let s = new D(0);
      for (let d = m.start; daysBetween(d, m.end) > 0; d = addDays(d, 1)) {
        const v = points.get(d);
        if (v !== null && v !== undefined) {
          s = s.plus(v);
          anyPoint = true;
        }
      }
      return s;
    });
    if (anyPoint) venues.set(venue, sums);
  }
  return { months, venues };
}

export function solveVS(day: DayData, endMonth: string, nMonths = 12): VSReference | undefined {
  const { months, venues: monthly } = vsMonthly(day, endMonth, nMonths);
  const ranked = [...monthly.entries()]
    .map(([venue, sums]) => ({ venue, total: sums.reduce((a, b) => a.plus(b), new D(0)), sums }))
    .sort((a, b) => b.total.comparedTo(a.total) || a.venue.localeCompare(b.venue));
  if (ranked.length < 5) return undefined;
  const top = ranked.slice(0, 5);
  const shares: Record<string, Record<string, string>> = {};
  for (const [i, m] of months.entries()) {
    const denom = top.reduce((a, t) => a.plus(t.sums[i] as DecimalValue), new D(0));
    if (denom.isZero()) return undefined;
    shares[m.month] = Object.fromEntries(
      top.map((t) => [t.venue, fmt((t.sums[i] as DecimalValue).div(denom).times(100))]),
    );
  }
  return { venues: top.map((t) => t.venue), months: months.map((m) => m.month), shares };
}

// ---- CR-PL: protocol P&L -----------------------------------------------------------------------------------------------------------------------
export interface PLReference {
  fees: string;
  payouts: string;
  revenue: string;
}

export interface Quarter {
  label: string;
  start: string;
  end: string;
}

/** The last four complete quarters before the window, newest first. */
export function plQuarters(window: string): Quarter[] {
  const qEnd = quarterStart(window);
  return Array.from({ length: 4 }, (_, k) => {
    const end = monthsBefore(qEnd, 3 * k);
    const start = monthsBefore(end, 3);
    const w = quarterWindow(
      Number(start.slice(0, 4)),
      Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1,
    );
    return {
      label: `${start.slice(0, 4)}-Q${Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1}`,
      start: w.start,
      end: w.end,
    };
  });
}

export function solvePL(
  day: DayData,
  protocolId: string,
  q: Pick<Quarter, "start" | "end">,
): PLReference | undefined {
  const series = day.lending.get(protocolId);
  if (series === undefined) return undefined;
  let fees = new D(0);
  let interest = new D(0);
  let nii = new D(0);
  let revenue = new D(0);
  for (let d = q.start; daysBetween(d, q.end) > 0; d = addDays(d, 1)) {
    const p = series.get(d);
    if (
      p === undefined ||
      p.fees === null ||
      p.revenue === null ||
      p.interest === null ||
      p.nii === null
    )
      return undefined; // a gap: not offered
    fees = fees.plus(p.fees);
    revenue = revenue.plus(p.revenue);
    interest = interest.plus(p.interest);
    nii = nii.plus(p.nii);
  }
  return { fees: fmt(fees), payouts: fmt(interest.minus(nii)), revenue: fmt(revenue) };
}

/**
 * The provider publishes each day's figures late, by a lag that depends on the time of day the snapshot is pulled (the reasons and the live evidence are with `MAX_PUBLICATION_LAG_DAYS` in the
 * snapshot plan). A solver that asked for the snapshot day itself, or one day back, offered no CR-UO and no CR-SM question on 2026-10-18 and 19. The tasks now use the latest day published,
 * within that many days, and the prompt states which day that is.
 */
export { MAX_PUBLICATION_LAG_DAYS };

// ---- CR-UO: unlock overhang --------------------------------------------------------------------------------------------------------------------
export interface UOReference {
  unlock30Pct: string;
  unlock90Pct: string;
  /** context for the prompt, not part of the answer: tokens unlocking in the windows, and the circulating supply they are measured against */
  unlock30Tokens: string;
  unlock90Tokens: string;
  circulating: string;
  /** the day that circulating supply is as of: the snapshot day, or the latest day before it the provider had published (at most `MAX_PUBLICATION_LAG_DAYS` back) */
  supplyDay: string;
}

export function solveUO(day: DayData, slug: string): UOReference | undefined {
  const sched = day.schedules.get(slug);
  const id = day.tokenIds.get(slug);
  if (
    sched === undefined ||
    id === undefined ||
    sched.days.length < 90 ||
    sched.days[0]?.day !== day.window
  )
    return undefined;
  const series = day.supply.get(id);
  let supply: DecimalValue | undefined;
  let supplyDay = day.window;
  // the latest figure the provider had published, up to a few days back; a null is a missing figure, never a zero
  for (let k = 0; k <= MAX_PUBLICATION_LAG_DAYS; k++) {
    const d = addDays(day.window, -k);
    const v = series?.get(d);
    if (v !== null && v !== undefined) {
      supply = v;
      supplyDay = d;
      break;
    }
  }
  if (supply === undefined || !supply.gt(0)) return undefined;
  const sum = (n: number) => sched.days.slice(0, n).reduce((a, d) => a.plus(d.native), new D(0));
  const [t30, t90] = [sum(30), sum(90)];
  return {
    unlock30Pct: fmt(t30.div(supply).times(100)),
    unlock90Pct: fmt(t90.div(supply).times(100)),
    unlock30Tokens: fmt(t30),
    unlock90Tokens: fmt(t90),
    circulating: fmt(supply),
    supplyDay,
  };
}

// ---- CR-SM: stablecoin movers ------------------------------------------------------------------------------------------------------------------
export type Dimension = "chain" | "issuer";
export interface SMReference {
  dimension: Dimension;
  /** the five largest absolute changes, largest first; the change is signed, in USD */
  top5: { id: string; changeUsd: string }[];
}

/**
 * The rows CR-SM ranks, and the two dates they are compared on. The start is 90 days before the snapshot day. The end is the latest day the stablecoin series reaches, which Blockworks
 * publishes late, by a lag that depends on when the snapshot is pulled (see `MAX_PUBLICATION_LAG_DAYS`: one day on 2026-10-17, two on the 18th and the 19th). So the end is the snapshot
 * day or up to that many days before it, whichever most series end on (the later one if they tie); a series that ends elsewhere, starts elsewhere or has no figure at an end is left
 * out. The prompt shows these rows and these dates, so the question and the key cannot differ.
 */
export function smRows(
  day: DayData,
  dimension: Dimension,
): { start: string; end: string; rows: { id: string; first: DecimalValue; last: DecimalValue }[] } {
  const start = addDays(day.window, -90);
  const usable = [...day.stablecoins[dimension]].filter(
    ([, b]) => b.first.usd !== null && b.last.usd !== null && b.first.day === start,
  );
  const count = (d: string) => usable.filter(([, b]) => b.last.day === d).length;
  // the end most series reach, counting from the snapshot day back; the strict `>` keeps the later day on a tie
  let end = day.window;
  let best = -1;
  for (let k = 0; k <= MAX_PUBLICATION_LAG_DAYS; k++) {
    const d = addDays(day.window, -k);
    const c = count(d);
    if (c > best) {
      best = c;
      end = d;
    }
  }
  const rows = usable
    .filter(([, b]) => b.last.day === end)
    .map(([id, b]) => ({
      id,
      first: b.first.usd as DecimalValue,
      last: b.last.usd as DecimalValue,
    }));
  return { start, end, rows };
}

export function solveSM(day: DayData, dimension: Dimension): SMReference | undefined {
  const { rows: usable } = smRows(day, dimension);
  const rows = usable.map((r) => ({ id: r.id, change: r.last.minus(r.first) }));
  if (rows.length < 5) return undefined;
  rows.sort((a, b) => b.change.abs().comparedTo(a.change.abs()) || a.id.localeCompare(b.id));
  return { dimension, top5: rows.slice(0, 5).map((r) => ({ id: r.id, changeUsd: fmt(r.change) })) };
}
