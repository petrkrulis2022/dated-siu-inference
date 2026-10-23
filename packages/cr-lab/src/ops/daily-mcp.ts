/**
 * The scheduled MCP-mode day (D116): what the scheduler runs, hourly, after the day's snapshot is in. Models research the day's questions through the live Blockworks MCP, and the answers
 * are graded from what they were shown (D101). The decisions here mirror the daily snapshot's (D100), because the failure modes are the same:
 *
 *  - It runs only when TODAY'S SNAPSHOT IS COMPLETE (its status, read here, never written): the questions are drawn from it. It does not grade anything: each session is graded against its own
 *    answer key, a REST pull taken just before it (`mcp/key-snapshot.ts`, D117), because the provider publishes through the morning and the day's one snapshot can be a day behind what the MCP
 *    serves later (2026-10-20: all 100 series compared ended one day later through the MCP at 12:49Z than in the 06:19Z snapshot). D116 had restricted sessions to a snapshot pulled from 12:00 UTC;
 *    that is replaced, because it does not keep the promise to Blockworks of an answer key taken at the same time.
 *  - One LOCK shared with the pull, so the two can never overlap; a run that finds it held does nothing.
 *  - A CATCH-UP: an hourly run that finds the day's sessions all recorded does nothing and sends no request; one that finds some missing runs the rest (a recorded session is never repeated).
 *    A session that met a SERVICE FAILURE is not recorded (`incident-guard.ts`), so it is drawn again; at `MAX_FAILED_ATTEMPTS` failed runs in a day it stops and says so.
 *  - ALERTS, a file always, an email and a toast where set up: a login that no longer works, a run that failed or was stopped (a service failure, the spend guard), the day's request ceiling,
 *    and an evening check (`watchdog`) that a day with a complete snapshot has all its sessions. Each kind alerts at most once per `ALERT_GAP_MS` per window.
 *
 * The status is its own file per day (`cr/mcp-status/`), using the snapshot status's shape: `pulled` is the sessions run this attempt, `fromStore` the sessions already recorded, `failed`
 * the sessions not recorded for a service failure, `requests` the live tool calls sent, `failedSteps` the instance and model of a session not recorded. Counts and names only, never a figure.
 */
import type { RunMcpDaySummary } from "../mcp/session.js";
import { McpSessionsAborted } from "../mcp/incident-guard.js";
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
import { ALERT_GAP_MS } from "./daily-snapshot.js";

/** The two models of D101 and the tasks the MCP can run for now (CR-UO waits for its metric names). */
export const MCP_MODELS: readonly string[] = ["claude-sonnet-5", "claude-haiku-4-5"];
/**
 * Live requests across a day's attempts, the MCP's tool calls and the Data API pulls of the answer keys together: a full day of six sessions is about 60 to 80 tool calls and up to about 55 key
 * pulls (my estimate, to be replaced by the first days' counts). Below 2 x the governor's 200 a group a day, so retries cannot add up past it.
 */
export const MCP_REQUEST_CEILING = 200;
/** Runs that stopped on a failure, per day, after which no more are tried: each can spend a session's money before the failure shows. */
export const MAX_FAILED_ATTEMPTS = 4;
/** The evening check judges a day only from this UTC hour (same reasoning as the snapshot's watchdog, D110). */
export const MCP_WATCHDOG_FROM_UTC_HOUR = 21;

export type DailyMcpOutcome =
  | "complete"
  | "partial"
  | "already-complete"
  | "snapshot-not-complete"
  | "already-running"
  | "failed"
  | "login-required"
  | "spend-stopped"
  | "request-ceiling"
  | "attempts-exhausted"
  | "watchdog-ok"
  | "watchdog-early"
  | "watchdog-snapshot-not-complete"
  | "watchdog-running"
  | "watchdog-alert";

/** Filled in by the run as it goes, so the live tool calls it sent are counted even when it ends on a failure (they count against the day's ceiling either way). */
export interface McpTally {
  requests: number;
}

export interface DailyMcpDeps {
  mode: "run" | "watchdog";
  /** this day's MCP status */
  status: StatusStore;
  /** the snapshot's status, read only */
  snapshotStatus: StatusStore;
  alerts: AlertSink;
  lockPath: string;
  /** the real run: connects, plays the day's missing sessions, returns the summary; a test passes a fake */
  run: (window: string, log: (l: string) => void, tally: McpTally) => Promise<RunMcpDaySummary>;
  /** true for the error that means "the stored login no longer works" */
  isLoginRequired: (e: unknown) => boolean;
  now?: () => Date;
  lockDeps?: LockDeps;
  log?: (line: string) => void;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export async function runDailyMcp(
  deps: DailyMcpDeps,
): Promise<{ outcome: DailyMcpOutcome; window: string }> {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const window = dayOf(now());

  const alert = async (kind: AlertKind, message: string): Promise<void> => {
    const st = deps.status.read(window) ?? emptyStatus(window);
    const last = st.alerts[kind];
    if (last !== undefined && now().getTime() - new Date(last).getTime() < ALERT_GAP_MS) {
      log(`alert suppressed (sent at ${last}): ${kind} ${window}`);
      return;
    }
    const a: Alert = { at: now().toISOString(), kind, window, message };
    await deps.alerts.send(a);
    st.alerts[kind] = a.at;
    deps.status.write(st);
    log(`ALERT ${kind} ${window}: ${message}`);
  };

  const todays = deps.status.read(window) ?? emptyStatus(window);
  const snapshotDone = deps.snapshotStatus.read(window)?.state === "complete";

  if (deps.mode === "watchdog") {
    if (todays.state === "complete") {
      log(`watchdog: the MCP sessions for ${window} are complete`);
      return { outcome: "watchdog-ok", window };
    }
    if (now().getUTCHours() < MCP_WATCHDOG_FROM_UTC_HOUR) {
      log(
        `watchdog: it is ${now().toISOString().slice(11, 16)} UTC, before the evening check (${MCP_WATCHDOG_FROM_UTC_HOUR}:00 UTC): not judging ${window}, which can still be completed`,
      );
      return { outcome: "watchdog-early", window };
    }
    if (!snapshotDone) {
      // no snapshot, so no MCP day is possible; the snapshot's own evening check reports that
      log(`watchdog: the snapshot for ${window} is not complete, so there is no MCP day to judge`);
      return { outcome: "watchdog-snapshot-not-complete", window };
    }
    const running = lockOwner(deps.lockPath, deps.lockDeps);
    if (running !== undefined) {
      log(
        `watchdog: ${running.label} (pid ${running.pid}) is running since ${running.startedAt}: not judging ${window} while it runs`,
      );
      return { outcome: "watchdog-running", window };
    }
    await alert(
      "mcp-not-complete",
      `the MCP-mode sessions for ${window} are not complete (${plural(todays.attempts.length, "attempt")} so far); the snapshot is in, the machine must be on, and the day can still be finished until midnight UTC`,
    );
    return { outcome: "watchdog-alert", window };
  }

  if (todays.state === "complete") {
    log(`${window} MCP sessions are already complete: nothing to do`);
    return { outcome: "already-complete", window };
  }
  if (!snapshotDone) {
    log(`the snapshot for ${window} is not complete yet: no MCP sessions without it`);
    return { outcome: "snapshot-not-complete", window };
  }
  if (requestsUsed(todays) >= MCP_REQUEST_CEILING) {
    await alert(
      "request-ceiling",
      `the MCP sessions for ${window} have already sent ${requestsUsed(todays)} tool calls across attempts (ceiling ${MCP_REQUEST_CEILING}); not sending more today`,
    );
    return { outcome: "request-ceiling", window };
  }
  const failedRuns = todays.attempts.filter((a) => a.outcome !== "complete").length;
  if (failedRuns >= MAX_FAILED_ATTEMPTS) {
    await alert(
      "mcp-run-failed",
      `${plural(failedRuns, "run")} of the MCP sessions for ${window} stopped on a failure; not trying again today (each can spend a session's money before the failure shows)`,
    );
    return { outcome: "attempts-exhausted", window };
  }

  let lock;
  try {
    lock = acquireLock(deps.lockPath, "daily-mcp", { now, ...deps.lockDeps });
  } catch (e) {
    if (!(e instanceof LockHeld)) throw e;
    log(`another live Blockworks process holds the lock (${e.message}): not starting`);
    return { outcome: "already-running", window };
  }

  /** Writes one attempt; the day is complete only when every planned session is recorded, which an attempt that ended well but was limited does not mean. */
  const record = (a: AttemptRecord, dayComplete = false): void => {
    const st: DayStatus = deps.status.read(window) ?? emptyStatus(window);
    st.attempts.push(a);
    if (dayComplete) {
      st.state = "complete";
      st.completedAt = a.at;
    }
    deps.status.write(st);
  };
  const tally: McpTally = { requests: 0 };
  const failure = (e: unknown): AttemptRecord => ({
    at: now().toISOString(),
    outcome: "error",
    pulled: 0,
    fromStore: 0,
    failed: e instanceof McpSessionsAborted ? 1 : 0,
    requests: tally.requests,
    failedSteps: e instanceof McpSessionsAborted ? [`${e.instance} / ${e.model}`] : [],
    error: e instanceof Error ? e.name : "UnknownError",
  });

  try {
    let s: RunMcpDaySummary;
    try {
      s = await deps.run(window, log, tally);
    } catch (e) {
      record(failure(e));
      if (deps.isLoginRequired(e)) {
        await alert(
          "mcp-login-failed",
          `the stored Blockworks MCP login no longer works, so the MCP sessions for ${window} could not run: sign in again (pnpm --filter @touchstone/cr-lab run mcp-login; a browser opens and you enter the key on Blockworks' own page)`,
        );
        return { outcome: "login-required", window };
      }
      await alert(
        "mcp-run-failed",
        e instanceof McpSessionsAborted
          ? `the MCP sessions for ${window} stopped: ${e.message}. It will be drawn again on the next scheduled run`
          : `the MCP sessions for ${window} stopped with ${e instanceof Error ? e.name : "an error"}; they will be retried on the next scheduled run`,
      );
      return { outcome: "failed", window };
    }
    record(
      {
        at: now().toISOString(),
        outcome: s.stopped !== undefined ? "failed" : "complete",
        pulled: s.attempted,
        fromStore: s.alreadyRecorded,
        failed: s.stopped !== undefined ? 1 : 0,
        requests: tally.requests,
        failedSteps: s.stopped !== undefined ? [`stopped: ${s.stopped.code}`] : [],
      },
      s.complete,
    );
    if (s.stopped !== undefined) {
      await alert(
        "mcp-run-failed",
        `the MCP sessions for ${window} were stopped by the spend guard (${s.stopped.code}, ${s.stopped.provider}): ${s.attempted} of ${s.planned - s.alreadyRecorded} sessions run`,
      );
      return { outcome: "spend-stopped", window };
    }
    log(
      `${window} MCP: ${s.attempted} run, ${s.alreadyRecorded} already recorded, ${s.passed} passed, $${s.usd}, ${tally.requests} tool calls${s.complete ? "" : " (not all planned sessions ran)"}`,
    );
    // a run that was limited (for example by --max-sessions) and did not finish the day leaves it open for the next run
    return { outcome: s.complete ? "complete" : "partial", window };
  } finally {
    lock.release();
  }
}
