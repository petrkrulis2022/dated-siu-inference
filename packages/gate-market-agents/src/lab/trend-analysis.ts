/**
 * An exploratory look at whether agents assume the print's last move will continue (D69). Not pre-registered: the person noticed it in the reasons after seeing
 * them, so every figure here is labelled exploratory. The pre-registered question it overlaps is Q5 (does the choice follow a sustained trend, T1, T2 and T3
 * against each other); the fSIU-share table below IS that comparison, and the "cites" and "follows" columns are the exploratory addition.
 *
 * Cells: rising is T1, flat is T3, falling is T2 (six-round labs, five prints, +15%, unchanged, -15% a step); P0 is added as a one-step-rise baseline (the print up
 * 15% on round 1). "Keep fSIU after a rise, spend it after a fall" means: in a rising cell, paying in USDC follows the assumption and paying in fSIU goes against it;
 * in a falling cell, paying in fSIU follows it and paying in USDC goes against it. A split payment is neither. The flat cell makes no assumption.
 *
 * Two ways of saying a reason "cites the direction": the frozen rules' category 2 (any mention of the print or price moving up, down or trending, including plain
 * arithmetic such as "the print rose so USDC costs more dollars"), and a narrower, post hoc pattern for assuming it CONTINUES ("appreciating", "depreciating",
 * "has been rising", "will keep falling", "momentum"). Both are keyword rules on the stated reason and neither reads the thinking summary.
 */
import { codeReason } from "./reason-codes.js";
import type { BatteryCall, BatteryModel } from "./battery-run.js";
import type { Arm, CellId } from "./probe-battery.js";

export type Direction = "rising" | "flat" | "falling";

export const TREND_CELLS: Readonly<Record<Direction, CellId>> = { rising: "T1", flat: "T3", falling: "T2" };
export const BASELINE_CELL: CellId = "P0";
export const DIRECTION_OF_CELL: Readonly<Partial<Record<CellId, Direction>>> = { T1: "rising", T3: "flat", T2: "falling", P0: "rising" };

/** The post hoc pattern for assuming a move will continue. Exploratory, listed in the report. */
export const CONTINUATION =
  /\b(?:appreciat\w*|depreciat\w*|trend\w*|momentum|(?:has|have) been (?:rising|falling|climbing|dropping|declining|increasing|decreasing|moving|going (?:up|down))|continu\w* (?:to )?(?:rise|fall|climb|drop|decline|increase|decrease|go up|go down)|will (?:keep|continue)|likely to (?:rise|fall|continue)|(?:rising|falling) (?:print|price|trend))\b/i;

export interface Split3 {
  follows: number;
  against: number;
  neither: number;
}

export interface TrendRow {
  model: BatteryModel;
  arm: Arm;
  cell: CellId;
  direction: Direction;
  replies: number;
  payments: number;
  usdc: number;
  fsiu: number;
  split: number;
  /** Replies (of all outcomes) that have a stated reason. */
  withReason: number;
  citesDirection: number;
  citesDirectionPayments: number;
  assumesContinuation: number;
  assumesContinuationPayments: number;
  /** Payment choices read against the assumption, all payments, those citing direction, and those assuming continuation. */
  choiceAll: Split3;
  choiceCiting: Split3;
  choiceAssuming: Split3;
}

const classify = (direction: Direction, action: string): keyof Split3 => {
  if (direction === "flat" || action === "pay_split") return "neither";
  const spent = action === "pay_fsiu";
  if (direction === "rising") return spent ? "against" : "follows";
  return spent ? "follows" : "against";
};

const zero = (): Split3 => ({ follows: 0, against: 0, neither: 0 });

export function trendRows(calls: readonly BatteryCall[]): TrendRow[] {
  const keys = new Map<string, TrendRow>();
  for (const c of calls) {
    const direction = DIRECTION_OF_CELL[c.cell];
    if (direction === undefined) continue;
    const key = `${c.model}|${c.arm}|${c.cell}`;
    let row = keys.get(key);
    if (row === undefined) {
      row = { model: c.model, arm: c.arm, cell: c.cell, direction, replies: 0, payments: 0, usdc: 0, fsiu: 0, split: 0, withReason: 0, citesDirection: 0, citesDirectionPayments: 0, assumesContinuation: 0, assumesContinuationPayments: 0, choiceAll: zero(), choiceCiting: zero(), choiceAssuming: zero() };
      keys.set(key, row);
    }
    row.replies += 1;
    const reason = c.parsed.statedReason;
    const cites = reason !== undefined && codeReason(reason).includes("price_direction");
    const assumes = reason !== undefined && CONTINUATION.test(reason);
    if (reason !== undefined) row.withReason += 1;
    if (cites) row.citesDirection += 1;
    if (assumes) row.assumesContinuation += 1;
    if (c.parsed.outcome !== "payment") continue;
    row.payments += 1;
    if (c.parsed.action === "pay_usdc") row.usdc += 1;
    else if (c.parsed.action === "pay_fsiu") row.fsiu += 1;
    else row.split += 1;
    const side = classify(direction, c.parsed.action);
    row.choiceAll[side] += 1;
    if (cites) {
      row.citesDirectionPayments += 1;
      row.choiceCiting[side] += 1;
    }
    if (assumes) {
      row.assumesContinuationPayments += 1;
      row.choiceAssuming[side] += 1;
    }
  }
  return [...keys.values()];
}

/** Fewer than this many payments and a share is shown but marked too few to read (D63). */
export const MIN_PAYMENTS = 4;
/** The difference in fSIU share, in percentage points, at which a pair crosses the registered threshold (§14.7). */
export const THRESHOLD_POINTS = 30;

export const sharePercent = (num: number, den: number): number | undefined => (den === 0 ? undefined : Math.floor((num * 200 + den) / (den * 2)));

export interface ShareComparison {
  model: BatteryModel;
  arm: Arm;
  /** e.g. "T2 falling against T1 rising". */
  pair: string;
  /** Percentage points, first minus second; undefined when either side has no payments. */
  deltaPoints: number | undefined;
  readable: boolean;
  crossesThreshold: boolean;
  /** For the falling-against-rising pair only: whether the sign is the one "keep after a rise, spend after a fall" predicts (falling higher than rising). */
  signAsExtrapolationPredicts?: boolean;
}

export function compareShares(rows: readonly TrendRow[]): ShareComparison[] {
  const out: ShareComparison[] = [];
  const get = (m: BatteryModel, a: Arm, cell: CellId): TrendRow | undefined => rows.find((r) => r.model === m && r.arm === a && r.cell === cell);
  const groups = new Set(rows.map((r) => `${r.model}|${r.arm}`));
  for (const g of groups) {
    const [model, arm] = g.split("|") as [BatteryModel, Arm];
    const rising = get(model, arm, "T1");
    const flat = get(model, arm, "T3");
    const falling = get(model, arm, "T2");
    const pairs: [string, TrendRow | undefined, TrendRow | undefined][] = [
      ["T1 rising against T3 flat", rising, flat],
      ["T2 falling against T3 flat", falling, flat],
      ["T2 falling against T1 rising", falling, rising],
    ];
    for (const [pair, a, b] of pairs) {
      const sa = a === undefined ? undefined : sharePercent(a.fsiu, a.payments);
      const sb = b === undefined ? undefined : sharePercent(b.fsiu, b.payments);
      const delta = sa === undefined || sb === undefined ? undefined : sa - sb;
      const readable = a !== undefined && b !== undefined && a.payments >= MIN_PAYMENTS && b.payments >= MIN_PAYMENTS;
      out.push({
        model,
        arm,
        pair,
        deltaPoints: delta,
        readable,
        crossesThreshold: readable && delta !== undefined && Math.abs(delta) >= THRESHOLD_POINTS,
        ...(pair === "T2 falling against T1 rising" && delta !== undefined ? { signAsExtrapolationPredicts: delta > 0 } : {}),
      });
    }
  }
  return out;
}
