/**
 * The daily snapshot, LIVE (D96): pulls today's candidate data for all four tasks through the data desk and stores it privately, hash-only manifest committed. A snapshot is of the day
 * it is pulled, so it refuses any other date. It is read-only, spends no model money, and respects the governor (paced, hourly and daily ceilings; it waits out the hourly limit
 * rather than stopping). Run again to resume: what is stored is not pulled twice. Prints step names, sizes and short hashes only, never a value.
 * `pnpm --filter @touchstone/cr-lab run snapshot-day`
 */
import { DataDesk } from "../data-desk/desk.js";
import { RateGovernor } from "../data-desk/governor.js";
import { liveBackendFromEnv } from "../data-desk/live.js";
import { runDailyPlan } from "../data-desk/snapshot-plan.js";
import { SnapshotStore, defaultStoreOptions } from "../data-desk/snapshots.js";

const today = new Date().toISOString().slice(0, 10);
const window = process.argv[2] ?? today;
if (window !== today) {
  console.error(
    `a snapshot is of the day it is pulled: refusing window ${window} (today is ${today} UTC)`,
  );
  process.exit(2);
}

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
const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`${stamp()} daily snapshot, window ${window}`);
await desk.recordSpecVersions(window);
const result = await runDailyPlan(desk, { window, log: (l) => console.log(`${stamp()} ${l}`) });
console.log(
  `\n${stamp()} done: ${result.pulled} pulled, ${result.fromStore} already stored, ${result.failed} failed`,
);
for (const r of governor.report()) {
  console.log(
    `  ${r.group}: ${r.requestsToday} requests, ${r.tooManyRequests} answered 429, ${r.backoffs} back-offs, ${(r.waitedMs / 1000).toFixed(0)} s waited, pace now one every ${r.spacingMs / 1000} s`,
  );
}
if (result.failed > 0) {
  console.log("failed steps (run again to retry them):");
  for (const s of result.steps.filter((x) => !x.ok)) console.log(`  ${s.step}: ${s.error}`);
  process.exit(1);
}
