/**
 * The scheduled daily snapshot (D100): what the scheduler runs, hourly. A run does the day's pull under the shared lock if the day is not yet complete, and otherwise does nothing and sends no
 * request; failures, an incomplete day and a missed day raise alerts (a file always, a desktop toast on Windows). `--watchdog` only checks the day and alerts if it is not complete.
 * Needs the Blockworks key in the environment (`node --env-file=../../.env`). Prints step names and outcomes, never a value.
 *   node --env-file=../../.env dist/cli/daily-snapshot.js [--watchdog]
 * Exit status: 0 for complete, already complete, or another run holding the lock; 1 for a failed pull, the request ceiling, or a watchdog alert.
 */
import { pullTodaysSnapshot } from "../data-desk/snapshot-run.js";
import { privatePath } from "../paths.js";
import { CompositeAlertSink, FileAlertSink, ToastAlertSink } from "../ops/alert.js";
import { runDailySnapshot } from "../ops/daily-snapshot.js";
import { StatusStore } from "../ops/status.js";

const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (l: string) => console.log(`${stamp()}Z ${l}`);

const mode = process.argv.includes("--watchdog") ? "watchdog" : "pull";
log(`daily-snapshot (${mode}) starting`);
const { outcome, window } = await runDailySnapshot({
  mode,
  status: new StatusStore(),
  alerts: new CompositeAlertSink([new FileAlertSink(), new ToastAlertSink()]),
  lockPath: privatePath("cr", "locks", "blockworks-live.lock"),
  pull: (w, l) => pullTodaysSnapshot({ window: w, log: l }),
  log,
});
log(`daily-snapshot ${window}: ${outcome}`);
process.exit(["failed", "request-ceiling", "watchdog-alert"].includes(outcome) ? 1 : 0);
