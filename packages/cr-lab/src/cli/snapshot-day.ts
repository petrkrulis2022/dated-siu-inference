/**
 * The daily snapshot, LIVE (D96), by hand: pulls today's candidate data for all four tasks through the data desk and stores it privately, hash-only manifest committed. A snapshot is of the
 * day it is pulled, so it refuses any other date. It is read-only, spends no model money, and respects the governor (paced, hourly and daily ceilings; it waits out the hourly limit
 * rather than stopping). Run again to resume: what is stored is not pulled twice. Prints step names, sizes and short hashes only, never a value.
 * The scheduled run (`daily-snapshot`) adds a lock, a catch-up and alerts around the same pull.
 * `pnpm --filter @touchstone/cr-lab run snapshot-day`
 */
import { pullTodaysSnapshot } from "../data-desk/snapshot-run.js";
import { privatePath } from "../paths.js";
import { recordPullAttempt } from "../ops/daily-snapshot.js";
import { LockHeld, acquireLock } from "../ops/lock.js";
import { StatusStore } from "../ops/status.js";

const today = new Date().toISOString().slice(0, 10);
const window = process.argv[2] ?? today;
if (window !== today) {
  console.error(
    `a snapshot is of the day it is pulled: refusing window ${window} (today is ${today} UTC)`,
  );
  process.exit(2);
}

// the one lock every live Blockworks process takes (the scheduled run too), so two pulls can never overlap
let lock;
try {
  lock = acquireLock(privatePath("cr", "locks", "blockworks-live.lock"), "snapshot-day (by hand)");
} catch (e) {
  if (!(e instanceof LockHeld)) throw e;
  console.error(
    `another live Blockworks process is running (${e.message}): not starting a second one`,
  );
  process.exit(3);
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    lock.release();
    process.exit(130);
  });

const stamp = () => new Date().toISOString().slice(11, 19);
console.log(`${stamp()} daily snapshot, window ${window}`);
const run = await pullTodaysSnapshot({
  window,
  log: (l) => console.log(`${stamp()} ${l}`),
}).finally(() => lock.release());
const { result, governor } = run;
recordPullAttempt(new StatusStore(), window, run);
console.log(
  `\n${stamp()} done: ${result.pulled} pulled, ${result.fromStore} already stored, ${result.failed} failed`,
);
for (const r of governor) {
  console.log(
    `  ${r.group}: ${r.requestsToday} requests, ${r.tooManyRequests} answered 429, ${r.backoffs} back-offs, ${(r.waitedMs / 1000).toFixed(0)} s waited, pace now one every ${r.spacingMs / 1000} s`,
  );
}
if (result.failed > 0) {
  console.log("failed steps (run again to retry them):");
  for (const s of result.steps.filter((x) => !x.ok)) console.log(`  ${s.step}: ${s.error}`);
  process.exit(1);
}
