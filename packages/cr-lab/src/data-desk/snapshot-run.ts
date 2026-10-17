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

export async function pullTodaysSnapshot(opts: {
  window: string;
  log: (line: string) => void;
}): Promise<SnapshotRunResult> {
  const governor = new RateGovernor({
    overrides: {
      "data-api": { waitOnHourlyLimit: true },
      "token-unlocks": { waitOnHourlyLimit: true },
    },
  });
  const desk = new DataDesk({
    backend: liveBackendFromEnv(),
    store: new SnapshotStore(defaultStoreOptions("live")),
    governor,
  });
  await desk.recordSpecVersions(opts.window);
  const result = await runDailyPlan(desk, { window: opts.window, log: opts.log });
  const report = governor.report();
  return { result, governor: report, requests: report.reduce((n, r) => n + r.requestsToday, 0) };
}
