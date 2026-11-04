/**
 * Pulls today's snapshot, LIVE (D96): the body of the `snapshot-day` command, kept here so the daily scheduled run and the hand-run command do exactly the same thing. It builds the
 * data desk from the Blockworks key in the environment, records the day's spec versions, and runs the daily plan, paced by the governor (which waits out the hourly limit rather than
 * stopping). What is stored is not pulled twice, so running it again resumes. It prints nothing itself; `log` receives step names, sizes and short hashes, never a value.
 */
import { DataDesk } from "./desk.js";
import { RateGovernor } from "./governor.js";
import { liveBackendFromEnv } from "./live.js";
import { runDailyPlan, type PlanResult } from "./snapshot-plan.js";
import { SnapshotStore, defaultStoreOptions } from "./snapshots.js";

export type GovernorReport = ReturnType<RateGovernor["report"]>;

export interface SnapshotRunResult {
  result: PlanResult;
  governor: GovernorReport;
  /** requests this run sent, across the data desk's request groups */
  requests: number;
}

/**
 * Blockworks' trial key allows 25 requests per clock hour, shared by every route (Data API, Token Unlocks and the MCP), refused requests included; the window resets at
 * the top of the hour (Blockworks, 2026-11-04). The snapshot therefore sends every request through ONE group, at most 24 per rolling hour (a rolling hour of 24 never puts
 * more than 24 into any clock hour), and waits the limit out rather than stopping. Before this, the two routes had a group of 30 each: up to 60 an hour together.
 */
export const BLOCKWORKS_GROUP = "blockworks";
export const BLOCKWORKS_PER_HOUR = 24;

export function snapshotGovernor(
  opts: Pick<ConstructorParameters<typeof RateGovernor>[0] & object, "now" | "sleep"> = {},
): RateGovernor {
  return new RateGovernor({
    ...opts,
    overrides: {
      [BLOCKWORKS_GROUP]: { waitOnHourlyLimit: true, maxRequestsPerHour: BLOCKWORKS_PER_HOUR },
    },
  });
}

export const snapshotGroupFor = (): string => BLOCKWORKS_GROUP;

export async function pullTodaysSnapshot(opts: {
  window: string;
  log: (line: string) => void;
}): Promise<SnapshotRunResult> {
  const governor = snapshotGovernor();
  const desk = new DataDesk({
    backend: liveBackendFromEnv(),
    store: new SnapshotStore(defaultStoreOptions("live")),
    governor,
    groupFor: snapshotGroupFor,
  });
  await desk.recordSpecVersions(opts.window);
  const result = await runDailyPlan(desk, { window: opts.window, log: opts.log });
  const report = governor.report();
  return { result, governor: report, requests: report.reduce((n, r) => n + r.requestsToday, 0) };
}
