/**
 * The lab's print: a scenario value that moves between rounds (instrument v6, D41). It is used inside the lab only. It is
 * never published, never the index, and never an input to a print: the published print stays what it is, and round 1 starts
 * from it.
 *
 * Each round after the first, the print goes up or down by `printStepBps`, with equal probability, drawn from the run's seed
 * (so a run can be reproduced from its seed alone). An up-step multiplies by 1 + s and a down-step by 1 − s, so the expected
 * print stays where it started: nothing in the scenario says which way it will go. Integer maths throughout, rounded down.
 *
 * Because the walk is bounded, everything it can reach is known before the run starts. The opening is sized at the highest
 * print it can reach, so that USDC alone is enough for every quote however the walk goes (D31, D41).
 */
import { deriveSeed, mulberry32 } from "@touchstone/basket";
import type { LabParams } from "./economy.js";
import { unitsToDecimal } from "./money.js";

const BPS = 10_000n;

export interface PrintPath {
  /** The print in force in each round, round 1 first, in nano-USD per SIU. */
  byRound: readonly bigint[];
  /** What each round's print is called: round 1 is the real print's own id, the rest are scenario ids. */
  ids: readonly string[];
}

export const stepUp = (p: bigint, stepBps: number): bigint => (p * (BPS + BigInt(stepBps))) / BPS;
export const stepDown = (p: bigint, stepBps: number): bigint => (p * (BPS - BigInt(stepBps))) / BPS;

/** The id a scenario print goes by in a quote's `print_id`: round 1 is the real print, and says so. */
export const printIdOfRound = (round: number, realPrintId: string): string => (round <= 1 ? realPrintId : `lab-scenario-round-${round}`);

/** The run's print in every round, from its seed. */
export function buildPrintPath(seed: number, p0: bigint, params: LabParams, realPrintId: string): PrintPath {
  if (!Number.isInteger(params.printStepBps) || params.printStepBps < 0 || params.printStepBps >= 10_000) {
    throw new Error(`printStepBps must be a whole number of basis points from 0 to 9,999, got ${params.printStepBps}`);
  }
  const rng = mulberry32(deriveSeed(seed, "print"));
  const byRound: bigint[] = [p0];
  for (let r = 2; r <= params.rounds; r++) {
    const prev = byRound[r - 2];
    byRound.push(params.printStepBps === 0 ? prev : rng() < 0.5 ? stepDown(prev, params.printStepBps) : stepUp(prev, params.printStepBps));
  }
  return { byRound, ids: byRound.map((_, i) => printIdOfRound(i + 1, realPrintId)) };
}

/** Every print the walk can reach in any round on any path, ascending and without repeats. */
export function reachablePrints(p0: bigint, params: LabParams): bigint[] {
  const seen = new Set<bigint>([p0]);
  let frontier: bigint[] = [p0];
  for (let r = 2; r <= params.rounds; r++) {
    const next: bigint[] = [];
    for (const p of frontier) {
      for (const q of params.printStepBps === 0 ? [p] : [stepDown(p, params.printStepBps), stepUp(p, params.printStepBps)]) {
        if (!next.includes(q)) next.push(q);
        seen.add(q);
      }
    }
    frontier = next;
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The highest print the walk can reach. */
export const ceilingPrint = (p0: bigint, params: LabParams): bigint => reachablePrints(p0, params).at(-1)!;

/**
 * How far the print moved from one round to the next, as a signed number of tenths of a percent, rounded half away from
 * zero: 150 is up 15.0%. Integers only.
 */
export function moveTenthsOfPercent(prev: bigint, next: bigint): number {
  const diff = (next - prev) * 1000n;
  const half = prev / 2n;
  const q = diff >= 0n ? (diff + half) / prev : -((-diff + half) / prev);
  return Number(q);
}

/** "up 15.0%", "down 15.0%" or "unchanged". */
export function describeMove(prev: bigint, next: bigint): string {
  const t = moveTenthsOfPercent(prev, next);
  if (t === 0) return "unchanged";
  const abs = Math.abs(t);
  return `${t > 0 ? "up" : "down"} ${Math.floor(abs / 10)}.${abs % 10}%`;
}

/** A print in nano-USD as the decimal USD per SIU an agent reads. */
export const printText = (p: bigint): string => unitsToDecimal(p, 9);
