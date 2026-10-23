/**
 * The daily snapshot (D96): everything the four tasks could draw on for one window, pulled once and hashed, so the models can be run on that day's data later. A snapshot is of the day
 * it is pulled (the unlock schedule and the supply are "as of" it), which is why the plan refuses any window but today's; a day not snapshotted cannot be recovered. History (venue
 * volume, lending quarters) is stable, but the same pull is repeated each day so a later restatement by Blockworks is caught, not silently inherited.
 *
 * The plan covers CANDIDATES, not instances: the day's seed draws the instances from these later, so the draw cannot influence what was pulled.
 *  - CR-VS: every perp venue's daily volume over the last 17 complete months (a 12-month window ending up to 5 months back).
 *  - CR-PL: every lending protocol over the last four complete quarters.
 *  - CR-UO: a fixed pool of tokens (the first `tokenPoolSize` eligible by a salted hash, so the pool is stable from day to day): the next 90 days of schedule and the circulating supply.
 *  - CR-SM (option B, D94): every stablecoin chain and issuer, supply on the day 90 days back and on the window's day.
 * A step that fails is recorded and the rest carry on; running the plan again resumes (what is stored is not pulled again).
 */
import { createHash } from "node:crypto";
import { addDays, firstOfMonth, monthsBefore } from "./dates.js";
import type { DataDesk } from "./desk.js";
import { DataDeskError } from "./desk.js";
import { Num, type Json } from "./json-decimal.js";
import { MAX_SERIES_PER_CALL, catalog } from "./queries.js";
import type { Query } from "./types.js";

export const POOL_SALT = "cr-uo-pool-v1";
export const DEFAULT_TOKEN_POOL = 20;
/** A token is eligible only if its schedule runs well past the window's 90 days: the schedule endpoint refuses a window that starts after the projected end. */
export const MIN_SCHEDULE_DAYS_AFTER = 100;
/**
 * How many days behind the snapshot day a series may end and still be used (the tasks' solvers read it from here). The provider publishes each day's figures late, by a lag that depends on
 * the time of day the snapshot is pulled: on 2026-10-17 (pulled 14:22Z) the stablecoin series ended the day before and the supply series reached the snapshot day; on the 18th and the 19th
 * (pulled about 06:30Z) the stablecoin series ended two days back and the supply series ended the day before. The circulating supply is therefore requested from this many days before the
 * snapshot day, so that an earlier day is in the snapshot when the day itself is not published yet.
 */
export const MAX_PUBLICATION_LAG_DAYS = 3;

export interface PlanStepResult {
  step: string;
  ok: boolean;
  fromStore?: boolean;
  bytes?: number;
  bodySha256?: string;
  error?: string;
}

export interface PlanResult {
  window: string;
  steps: PlanStepResult[];
  pulled: number;
  fromStore: number;
  failed: number;
}

type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Num)
    ? (v as Obj)
    : undefined;
const rowsOf = (j: Json): Obj[] =>
  (Array.isArray(obj(j)?.data) ? (obj(j)?.data as Json[]) : [])
    .map((r) => obj(r))
    .filter((r): r is Obj => r !== undefined);
const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
/** The `id` (or another field) of every row of a tabular response, in order: the series keys the timeseries pulls name. */
export const idsOfRows = (json: Json, field = "id"): string[] =>
  rowsOf(json)
    .map((r) => str(r[field]))
    .filter((x): x is string => x !== undefined);

export const batches = <T>(xs: readonly T[], n: number): T[][] =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

/** The first day of the quarter containing `date`. */
export function quarterStart(date: string): string {
  const [y, m] = [date.slice(0, 4), Number(date.slice(5, 7))];
  return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
}

/** Whether a token's schedule can be asked for from `window` for 90 days (it has begun, and it runs past the window by a margin). */
export function eligibleToken(row: Obj, window: string): boolean {
  const genesis = str(row.genesisDate)?.slice(0, 10);
  const end = str(row.projectedEndDate)?.slice(0, 10);
  return (
    str(row.slug) !== undefined &&
    str(row.id) !== undefined &&
    genesis !== undefined &&
    end !== undefined &&
    genesis <= window &&
    end >= addDays(window, MIN_SCHEDULE_DAYS_AFTER)
  );
}

/** The CR-UO pool: eligible tokens in the order of a salted hash of their slug, first `size`. The same inputs always give the same pool, so it is stable across days. */
export function tokenPool(
  rows: readonly Obj[],
  window: string,
  size = DEFAULT_TOKEN_POOL,
): { slug: string; id: string }[] {
  return rows
    .filter((r) => eligibleToken(r, window))
    .map((r) => ({
      slug: str(r.slug) as string,
      id: str(r.id) as string,
      rank: createHash("sha256")
        .update(`${POOL_SALT}:${str(r.slug)}`)
        .digest("hex"),
    }))
    .sort((a, b) => a.rank.localeCompare(b.rank))
    .slice(0, size)
    .map(({ slug, id }) => ({ slug, id }));
}

export async function runDailyPlan(
  desk: DataDesk,
  input: { window: string; tokenPoolSize?: number; log?: (line: string) => void },
): Promise<PlanResult> {
  const { window } = input;
  const log = input.log ?? (() => undefined);
  const steps: PlanStepResult[] = [];

  const pull = async (step: string, q: Query) => {
    try {
      const s = await desk.pull(q, { window });
      steps.push({
        step,
        ok: true,
        fromStore: s.fromStore,
        bytes: s.bytes,
        bodySha256: s.bodySha256,
      });
      log(
        `ok    ${step} ${s.bytes}B ${s.bodySha256.slice(0, 10)}${s.fromStore ? " (stored)" : ""}`,
      );
      return s;
    } catch (err) {
      const message =
        err instanceof DataDeskError || err instanceof Error ? err.message : String(err);
      steps.push({ step, ok: false, error: message });
      log(`FAIL  ${step}: ${message}`);
      return undefined;
    }
  };
  const ids = (s: { json: Json } | undefined, field = "id"): string[] =>
    s === undefined ? [] : idsOfRows(s.json, field);

  // CR-VS
  const months = { start: monthsBefore(firstOfMonth(window), 17), end: firstOfMonth(window) };
  const venues = ids(await pull("perp venues", catalog.perpVenues()));
  for (const [i, b] of batches(venues, MAX_SERIES_PER_CALL).entries())
    await pull(`perp volume batch ${i + 1}`, catalog.perpVolume(b, months.start, months.end));

  // CR-PL
  const qEnd = quarterStart(window);
  const quarters = { start: monthsBefore(qEnd, 12), end: qEnd };
  const lending = ids(await pull("lending protocols", catalog.lendingProtocols()));
  for (const [i, b] of batches(lending, MAX_SERIES_PER_CALL).entries())
    await pull(
      `lending financials batch ${i + 1}`,
      catalog.lendingFinancials(b, quarters.start, quarters.end),
    );

  // CR-UO
  const assets = await pull("token unlock assets", catalog.tokenUnlockAssets());
  const pool =
    assets === undefined ? [] : tokenPool(rowsOf(assets.json), window, input.tokenPoolSize);
  for (const [i, t] of pool.entries())
    await pull(
      `unlock schedule ${i + 1} of ${pool.length}`,
      catalog.tokenUnlockSchedule(t.slug, "DAILY", window, addDays(window, 90)),
    );
  for (const [i, b] of batches(
    pool.map((t) => t.id),
    MAX_SERIES_PER_CALL,
  ).entries())
    await pull(
      `circulating supply batch ${i + 1}`,
      catalog.assetSupply(b, addDays(window, -MAX_PUBLICATION_LAG_DAYS), addDays(window, 1)),
    );

  // CR-SM, option B
  const start90 = addDays(window, -90);
  const chains = ids(await pull("stablecoin chains", catalog.stablecoinChains()));
  for (const [i, b] of batches(chains, MAX_SERIES_PER_CALL).entries())
    await pull(
      `stablecoins by chain batch ${i + 1}`,
      catalog.stablecoinsByChain(b, start90, addDays(window, 1)),
    );
  const issuers = ids(await pull("stablecoin issuers", catalog.stablecoinIssuers()));
  for (const [i, b] of batches(issuers, MAX_SERIES_PER_CALL).entries())
    await pull(
      `stablecoins by issuer batch ${i + 1}`,
      catalog.stablecoinsByIssuer(b, start90, addDays(window, 1)),
    );

  return {
    window,
    steps,
    pulled: steps.filter((s) => s.ok && !s.fromStore).length,
    fromStore: steps.filter((s) => s.ok && s.fromStore).length,
    failed: steps.filter((s) => !s.ok).length,
  };
}
