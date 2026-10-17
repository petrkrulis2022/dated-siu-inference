/**
 * The scheduled daily snapshot: the pull itself plus the three safeguards the owner asked for (D100).
 *
 *  - A LOCK, so two live Blockworks processes can never overlap (`blockworks-live.lock`, shared with every other live process).
 *  - A CATCH-UP: the schedule runs this every hour, and a run that finds the day already complete does nothing and sends no request. So if the machine was asleep at the fixed morning
 *    time, the first hourly run after it wakes pulls the day, still the same UTC day. A missed UTC day cannot be recovered (a snapshot is of the day it is pulled), and the run says so.
 *  - ALERTS, to a file always and to a desktop toast where there is one: a pull that fails, a day not complete at the evening check (`watchdog`), a yesterday that was never completed,
 *    a lock held by a stuck process, and the request ceiling. Each kind alerts at most once per `ALERT_GAP_MS` per window, so a failing day does not alert every hour.
 *
 * The governor counts requests per process, so across hourly retries this run keeps its own tally in the day's status file and stops at `REQUEST_CEILING` (below the governor's 200 a day)
 * rather than let retries add up past the limit. It never sends a request when the day is complete.
 */
import { addDays } from "../data-desk/dates.js";
import type { SnapshotRunResult } from "../data-desk/snapshot-run.js";
import { acquireLock, lockOwner, LockHeld, type LockDeps } from "./lock.js";
import type { Alert, AlertSink } from "./alert.js";
import {
  emptyStatus,
  requestsUsed,
  type AlertKind,
  type AttemptRecord,
  type DayStatus,
  type StatusStore,
} from "./status.js";

export const REQUEST_CEILING = 150;
export const ALERT_GAP_MS = 6 * 3_600_000;
/** a lock held by a live process this long is reported as stuck */
export const STUCK_LOCK_MS = 6 * 3_600_000;

export type DailyOutcome =
  | "complete"
  | "already-complete"
  | "already-running"
  | "failed"
  | "request-ceiling"
  | "watchdog-ok"
  | "watchdog-alert";

/** Records one pull's outcome in the day's status (completing the day if nothing failed). Shared by the scheduled run and the hand-run command, so the schedule knows a day done by hand. */
export function recordPullAttempt(
  store: StatusStore,
  window: string,
  out: SnapshotRunResult,
  at: Date = new Date(),
): AttemptRecord {
  const attempt: AttemptRecord = {
    at: at.toISOString(),
    outcome: out.result.failed === 0 ? "complete" : "failed",
    pulled: out.result.pulled,
    fromStore: out.result.fromStore,
    failed: out.result.failed,
    requests: out.requests,
    failedSteps: out.result.steps.filter((s) => !s.ok).map((s) => s.step),
  };
  const st: DayStatus = store.read(window) ?? emptyStatus(window);
  st.attempts.push(attempt);
  if (attempt.outcome === "complete") {
    st.state = "complete";
    st.completedAt = attempt.at;
  }
  store.write(st);
  return attempt;
}

export interface DailyDeps {
  mode: "pull" | "watchdog";
  status: StatusStore;
  alerts: AlertSink;
  lockPath: string;
  /** the real pull; a test passes a fake */
  pull: (window: string, log: (l: string) => void) => Promise<SnapshotRunResult>;
  now?: () => Date;
  lockDeps?: LockDeps;
  log?: (line: string) => void;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export async function runDailySnapshot(
  deps: DailyDeps,
): Promise<{ outcome: DailyOutcome; window: string }> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const window = dayOf(now());

  const alert = async (kind: AlertKind, forWindow: string, message: string): Promise<void> => {
    const st = deps.status.read(forWindow) ?? emptyStatus(forWindow);
    const last = st.alerts[kind];
    if (last !== undefined && now().getTime() - new Date(last).getTime() < ALERT_GAP_MS) {
      log(`alert suppressed (sent at ${last}): ${kind} ${forWindow}`);
      return;
    }
    const a: Alert = { at: now().toISOString(), kind, window: forWindow, message };
    await deps.alerts.send(a);
    st.alerts[kind] = a.at;
    deps.status.write(st);
    log(`ALERT ${kind} ${forWindow}: ${message}`);
  };

  // a day that was never completed cannot be recovered: say so, once per missed day, for the last week since the schedule first ran
  const first = deps.status.windows()[0];
  if (first !== undefined)
    for (let d = addDays(window, -7); d < window; d = addDays(d, 1)) {
      if (d < first) continue;
      const st = deps.status.read(d);
      if (st?.state === "complete" || st?.alerts["yesterday-missing"] !== undefined) continue;
      await alert(
        "yesterday-missing",
        d,
        `the snapshot for ${d} never completed and cannot be recovered (a snapshot is of the day it is pulled)`,
      );
    }

  const todays = deps.status.read(window) ?? emptyStatus(window);

  if (deps.mode === "watchdog") {
    if (todays.state === "complete") {
      log(`watchdog: ${window} is complete`);
      return { outcome: "watchdog-ok", window };
    }
    await alert(
      "not-complete",
      window,
      `the snapshot for ${window} is not complete (${todays.attempts.length} attempt${todays.attempts.length === 1 ? "" : "s"} so far); the machine must be on and the day can still be finished until midnight UTC`,
    );
    return { outcome: "watchdog-alert", window };
  }

  if (todays.state === "complete") {
    log(`${window} is already complete: nothing to do`);
    return { outcome: "already-complete", window };
  }

  if (requestsUsed(todays) >= REQUEST_CEILING) {
    await alert(
      "request-ceiling",
      window,
      `this window has already used ${requestsUsed(todays)} requests across attempts (ceiling ${REQUEST_CEILING}); not sending more today`,
    );
    return { outcome: "request-ceiling", window };
  }

  let lock;
  try {
    lock = acquireLock(deps.lockPath, "daily-snapshot", { now, ...deps.lockDeps });
  } catch (e) {
    if (!(e instanceof LockHeld)) throw e;
    log(`another live Blockworks process holds the lock (${e.message}): not starting`);
    const owner = lockOwner(deps.lockPath, deps.lockDeps);
    if (
      owner !== undefined &&
      now().getTime() - new Date(owner.startedAt).getTime() > STUCK_LOCK_MS
    )
      await alert(
        "lock-stuck",
        window,
        `the Blockworks lock has been held by ${owner.label} (pid ${owner.pid}) since ${owner.startedAt}, which looks stuck`,
      );
    return { outcome: "already-running", window };
  }

  try {
    let attempt: AttemptRecord;
    try {
      attempt = recordPullAttempt(deps.status, window, await deps.pull(window, log), now());
    } catch (e) {
      attempt = {
        at: now().toISOString(),
        outcome: "error",
        pulled: 0,
        fromStore: 0,
        failed: 0,
        requests: 0,
        failedSteps: [],
        error: e instanceof Error ? e.name : "UnknownError",
      };
      const st: DayStatus = deps.status.read(window) ?? emptyStatus(window);
      st.attempts.push(attempt);
      deps.status.write(st);
    }
    if (attempt.outcome === "complete") {
      log(
        `${window} complete: ${attempt.pulled} pulled, ${attempt.fromStore} already stored, ${attempt.requests} requests`,
      );
      return { outcome: "complete", window };
    }
    await alert(
      "pull-failed",
      window,
      attempt.outcome === "error"
        ? `the snapshot pull stopped with ${attempt.error}; it will be retried on the next scheduled run`
        : `${attempt.failed} step${attempt.failed === 1 ? "" : "s"} of the snapshot failed (${attempt.failedSteps.slice(0, 3).join("; ")}${attempt.failedSteps.length > 3 ? "; ..." : ""}); it will be retried on the next scheduled run`,
    );
    return { outcome: "failed", window };
  } finally {
    lock.release();
  }
}
