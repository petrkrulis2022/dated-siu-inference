/**
 * v2 item 10 (docs/marketplace-redesign-v2.md): the stand-in replays the REAL, already-published Dated SIU prints across the run's windows, instead of holding one frozen
 * print constant for the whole run -- one published day's print per simulated window, in calendar order from a fixed start date. This is honest rather than a path the
 * experimenter chose: real, already-printed history, not an authored scenario.
 *
 * Only the PRICE axis replays. The stand-in worker's own calibration (each issuer model's measured pass rate per task type, `passRates(wp0)`) has no real-world equivalent --
 * the real print pipeline measures basket cost, never CR-task-type pass rates -- so it stays fixed from the committed `cr-print.json` fixture, unchanged.
 *
 * A calendar date counts only if BOTH grade-split prints exist for it (`{date}-commodity.json` and `{date}-frontier.json`, under the repo's real `data/prints/`, never the
 * cr-lab fixture at `data/lab/cr/economy/cr-print.json`); a date missing either is skipped entirely, so both grades always move together, never one stale against the other.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "../paths.js";
import type { Series } from "./memory-chain.js";
import type { NanoUsdPerSiu } from "./units.js";

const PRINTS_DIR = join(REPO_ROOT, "data", "prints");

interface GradePrint {
  series: Series;
  dated_siu: string;
}

function readGradePrint(date: string, series: Series): GradePrint | undefined {
  try {
    return JSON.parse(readFileSync(join(PRINTS_DIR, `${date}-${series}.json`), "utf-8")) as GradePrint;
  } catch {
    return undefined;
  }
}

/** a decimal USD-per-SIU string ("0.0014") to nano-USD-per-SIU, exact integer-string arithmetic, no floats -- the same unit `WP0`'s own nanoUsdPerSiu already uses */
export function datedSiuToNanoUsdPerSiu(datedSiu: string): NanoUsdPerSiu {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(datedSiu.trim());
  if (m === null) throw new Error(`print-history: not a plain decimal: ${JSON.stringify(datedSiu)}`);
  const whole = m[1] as string;
  const frac = (m[2] ?? "").padEnd(9, "0").slice(0, 9); // nano = 1e-9
  if ((m[2]?.length ?? 0) > 9) throw new Error(`print-history: more than 9 decimals: ${datedSiu}`);
  return BigInt(whole) * 1_000_000_000n + BigInt(frac || "0");
}

function nextCalendarDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * One window per calendar day that has BOTH grade prints, starting at `startDate`, walking forward until `windowCount` windows are filled (skipping gap days without
 * consuming a window slot). Throws if the real history runs out before `windowCount` windows are found -- never silently repeats or invents a day.
 */
export function printHistorySchedule(
  startDate: string,
  windowCount: number,
): Map<number, Readonly<Record<Series, NanoUsdPerSiu>>> {
  const out = new Map<number, Readonly<Record<Series, NanoUsdPerSiu>>>();
  let date = startDate;
  let k = 1;
  // a generous bound on calendar days walked, so a bad startDate/windowCount fails fast with a clear error instead of looping forever
  for (let steps = 0; k <= windowCount && steps < 3650; steps++, date = nextCalendarDay(date)) {
    const commodity = readGradePrint(date, "commodity");
    const frontier = readGradePrint(date, "frontier");
    if (commodity === undefined || frontier === undefined) continue;
    out.set(k, {
      commodity: datedSiuToNanoUsdPerSiu(commodity.dated_siu),
      frontier: datedSiuToNanoUsdPerSiu(frontier.dated_siu),
    });
    k++;
  }
  if (out.size < windowCount)
    throw new Error(
      `print-history: only found ${out.size} of ${windowCount} windows' worth of real prints starting ${startDate}`,
    );
  return out;
}
