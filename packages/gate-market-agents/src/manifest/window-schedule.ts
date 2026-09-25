import { deriveSeed, mulberry32, shuffle, toSeed } from "@touchstone/basket";
import type { TaskClass } from "@touchstone/task-pack-gate-hardening";

/**
 * P5's "three weekly delivery windows" compressed to hours for this run, per the run's own
 * settled decision — a full run finishes in a day instead of three weeks. `windowDurationSeconds`
 * and `jobsPerWindow` are manifest parameters, not hardcoded, so a later run can vary them.
 * `WorkClaim.mint`'s own `windowFrom`/`windowTo` for every job minted in a window use these real
 * bounds, so `computeTimeToExpirySeconds` (context/expiry.ts) reflects the window agents actually
 * face rather than a fictional weekly one.
 */
export interface WindowBounds {
  windowIndex: number;
  windowFrom: bigint;
  windowTo: bigint;
}

export function windowBounds(
  runStartUnixSeconds: bigint,
  windowIndex: number,
  windowDurationSeconds: bigint,
): WindowBounds {
  const windowFrom = runStartUnixSeconds + BigInt(windowIndex) * windowDurationSeconds;
  return { windowIndex, windowFrom, windowTo: windowFrom + windowDurationSeconds };
}

/**
 * Real seeded job-class alternation for one window — spec §9.2's "6-10 jobs per window,
 * alternating class." Deterministic under `seed` alone (never model sampling, which stays fixed
 * at `temperature: 0` regardless of seed — see this repo's own precursor passes), so five future
 * runs "differing only in seed" (spec §7.1(c)) is a real, reproducible property: the same seed
 * always produces the same job count and the same class sequence for a given window.
 */
export function jobClassesForWindow(
  seed: string,
  windowIndex: number,
  minJobs: number,
  maxJobs: number,
): TaskClass[] {
  const windowSeed = deriveSeed(toSeed(seed), "window", windowIndex);
  const rng = mulberry32(windowSeed);
  const jobCount = minJobs + Math.floor(rng() * (maxJobs - minJobs + 1));

  // "Alternating class" starting from a seeded coin flip, not always the same class first — a
  // real run shouldn't always open on `code` just because that happens to be listed first.
  const classes: TaskClass[] = [];
  let next: TaskClass = rng() < 0.5 ? "code" : "extract";
  for (let i = 0; i < jobCount; i++) {
    classes.push(next);
    next = next === "code" ? "extract" : "code";
  }
  return classes;
}

/** Real seeded turn order for one window's roster — used by the loop to decide who goes next,
 * never to decide *what* an agent does (that's the model's own reasoning, never scheduled). */
export function shuffledTurnOrder<T>(seed: string, windowIndex: number, roster: readonly T[]): T[] {
  const windowSeed = deriveSeed(toSeed(seed), "turn-order", windowIndex);
  return shuffle(mulberry32(windowSeed), roster);
}
