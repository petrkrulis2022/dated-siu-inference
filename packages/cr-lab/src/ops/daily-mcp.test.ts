import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpSessionsAborted } from "../mcp/incident-guard.js";
import { McpLoginRequired } from "../mcp/live-mcp.js";
import type { RunMcpDaySummary } from "../mcp/session.js";
import { MemoryAlertSink } from "./alert.js";
import {
  MAX_FAILED_ATTEMPTS,
  MCP_REQUEST_CEILING,
  MCP_WATCHDOG_FROM_UTC_HOUR,
  runDailyMcp,
  type DailyMcpDeps,
} from "./daily-mcp.js";
import { ALERT_GAP_MS } from "./daily-snapshot.js";
import { acquireLock } from "./lock.js";
import { StatusStore, emptyStatus } from "./status.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-daily-mcp-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const DAY = "2026-10-20";
const T0 = new Date(`${DAY}T14:00:00Z`);
const clock = (start: Date) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
};
const summary = (over: Partial<RunMcpDaySummary> = {}): RunMcpDaySummary => ({
  window: DAY,
  planned: 6,
  alreadyRecorded: 0,
  attempted: 6,
  passed: 5,
  usd: "2.5",
  complete: true,
  ...over,
});

let seq = 0;
function setup(
  run: (tally: { requests: number }) => Promise<RunMcpDaySummary>,
  opts: { snapshotComplete?: boolean; start?: Date } = {},
) {
  const c = clock(opts.start ?? T0);
  const alerts = new MemoryAlertSink();
  const home = join(tmp, `world-${++seq}`);
  const status = new StatusStore(join(home, "mcp-status"));
  const snapshotStatus = new StatusStore(join(home, "status"));
  if (opts.snapshotComplete !== false)
    snapshotStatus.write({ ...emptyStatus(DAY), state: "complete", completedAt: T0.toISOString() });
  const calls = { n: 0 };
  const deps = (mode: "run" | "watchdog" = "run"): DailyMcpDeps => ({
    mode,
    status,
    snapshotStatus,
    alerts,
    lockPath: join(home, "locks", "live.lock"),
    run: async (_w, _l, tally) => {
      calls.n += 1;
      return run(tally);
    },
    isLoginRequired: (e) => e instanceof McpLoginRequired,
    now: c.now,
  });
  return { c, alerts, status, snapshotStatus, calls, deps, home };
}

describe("the scheduled MCP day: when it runs", () => {
  it("waits for the day's snapshot: no snapshot, no sessions, no request, no alert", async () => {
    const s = setup(async () => summary(), { snapshotComplete: false });
    expect((await runDailyMcp(s.deps())).outcome).toBe("snapshot-not-complete");
    expect(s.calls.n).toBe(0);
    expect(s.alerts.alerts).toEqual([]);
    expect(s.status.read(DAY)).toBeUndefined();
  });

  it("plays sessions on any complete snapshot of the day, even one pulled in the early morning: each session is graded against its own answer key, taken at its own time (D117)", async () => {
    const s = setup(async () => summary());
    s.snapshotStatus.write({
      ...emptyStatus(DAY),
      state: "complete",
      completedAt: `${DAY}T06:19:44Z`,
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("complete");
    expect(s.calls.n).toBe(1);
  });

  it("runs once the snapshot is in, records the day complete, and then does nothing on later hourly runs", async () => {
    const s = setup(async (t) => {
      t.requests = 61;
      return summary();
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("complete");
    const st = s.status.read(DAY);
    expect(st).toMatchObject({ state: "complete" });
    expect(st?.attempts).toEqual([
      expect.objectContaining({
        outcome: "complete",
        pulled: 6,
        fromStore: 0,
        failed: 0,
        requests: 61,
      }),
    ]);
    s.c.advance(3_600_000);
    expect((await runDailyMcp(s.deps())).outcome).toBe("already-complete");
    expect(s.calls.n).toBe(1);
  });

  it("a run limited to some sessions leaves the day open, and the next run plays the rest", async () => {
    let first = true;
    const s = setup(async () => {
      if (first) {
        first = false;
        return summary({ attempted: 1, complete: false });
      }
      return summary({ attempted: 5, alreadyRecorded: 1 });
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("partial");
    expect(s.status.read(DAY)?.state).toBe("incomplete");
    expect(s.alerts.alerts).toEqual([]);
    s.c.advance(3_600_000);
    expect((await runDailyMcp(s.deps())).outcome).toBe("complete");
    expect(s.status.read(DAY)?.state).toBe("complete");
    expect(s.calls.n).toBe(2);
  });

  it("does nothing while another live Blockworks process (the pull) holds the lock, and sends no alert", async () => {
    const s = setup(async () => summary());
    const held = acquireLock(join(s.home, "locks", "live.lock"), "daily-snapshot");
    try {
      expect((await runDailyMcp(s.deps())).outcome).toBe("already-running");
    } finally {
      held.release();
    }
    expect(s.calls.n).toBe(0);
    expect(s.alerts.alerts).toEqual([]);
  });

  it("releases the lock when it is done, even when the run fails", async () => {
    const s = setup(async () => {
      throw new Error("boom");
    });
    await runDailyMcp(s.deps());
    const again = acquireLock(join(s.home, "locks", "live.lock"), "next");
    again.release();
  });
});

describe("the scheduled MCP day: what goes wrong, and who is told", () => {
  it("a stored login that no longer works alerts at once, with the way to fix it, and counts as a failed attempt", async () => {
    const s = setup(async () => {
      throw new McpLoginRequired();
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("login-required");
    expect(s.alerts.alerts).toHaveLength(1);
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "mcp-login-failed", window: DAY });
    expect(s.alerts.alerts[0]?.message).toContain("mcp-login");
    expect(s.status.read(DAY)?.attempts[0]).toMatchObject({
      outcome: "error",
      error: "McpLoginRequired",
    });
    expect(s.status.read(DAY)?.state).toBe("incomplete");
  });

  it("a session lost to a service failure alerts, names the session, and is left to be drawn again", async () => {
    const aborted = new McpSessionsAborted(
      { kind: "rate-limited", detail: "RateLimited (429)" },
      "CR-VS-1",
      "claude-sonnet-5",
    );
    let fail = true;
    const s = setup(async (t) => {
      t.requests = 14;
      if (fail) throw aborted;
      return summary({ alreadyRecorded: 2, attempted: 4 });
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("failed");
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "mcp-run-failed" });
    expect(s.alerts.alerts[0]?.message).toContain("RateLimited (429)");
    expect(s.status.read(DAY)?.attempts[0]).toMatchObject({
      outcome: "error",
      failed: 1,
      requests: 14,
      failedSteps: ["CR-VS-1 / claude-sonnet-5"],
    });
    fail = false;
    s.c.advance(3_600_000);
    expect((await runDailyMcp(s.deps())).outcome).toBe("complete");
  });

  it("the spend guard stopping the run is a stop, not a finished day, and alerts", async () => {
    const s = setup(async () =>
      summary({
        attempted: 2,
        complete: false,
        stopped: { code: "daily-cap", reason: "cap", provider: "anthropic" } as never,
      }),
    );
    expect((await runDailyMcp(s.deps())).outcome).toBe("spend-stopped");
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "mcp-run-failed" });
    expect(s.alerts.alerts[0]?.message).toContain("spend guard");
    expect(s.status.read(DAY)?.state).toBe("incomplete");
  });

  it("a failing day does not alert every hour: once per gap for each kind", async () => {
    const s = setup(async () => {
      throw new Error("boom");
    });
    await runDailyMcp(s.deps());
    s.c.advance(3_600_000);
    await runDailyMcp(s.deps());
    s.c.advance(3_600_000);
    await runDailyMcp(s.deps());
    expect(s.alerts.alerts.filter((a) => a.kind === "mcp-run-failed")).toHaveLength(1);
    s.c.advance(ALERT_GAP_MS);
    await runDailyMcp(s.deps());
    expect(s.alerts.alerts.filter((a) => a.kind === "mcp-run-failed")).toHaveLength(2);
  });

  it("stops trying after the day's allowance of failed runs, since each can spend a session's money before it fails", async () => {
    const s = setup(async () => {
      throw new Error("boom");
    });
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect((await runDailyMcp(s.deps())).outcome).toBe("failed");
      s.c.advance(3_600_000);
    }
    expect(s.calls.n).toBe(MAX_FAILED_ATTEMPTS);
    expect((await runDailyMcp(s.deps())).outcome).toBe("attempts-exhausted");
    expect(s.calls.n).toBe(MAX_FAILED_ATTEMPTS);
  });

  it("stops at the day's ceiling on live tool calls, counted across attempts, and says so", async () => {
    const s = setup(async (t) => {
      t.requests = MCP_REQUEST_CEILING;
      throw new Error("boom");
    });
    expect((await runDailyMcp(s.deps())).outcome).toBe("failed");
    s.c.advance(3_600_000);
    expect((await runDailyMcp(s.deps())).outcome).toBe("request-ceiling");
    expect(s.calls.n).toBe(1);
    expect(s.alerts.alerts.some((a) => a.kind === "request-ceiling")).toBe(true);
  });
});

describe("the evening check", () => {
  const evening = new Date(`${DAY}T${String(MCP_WATCHDOG_FROM_UTC_HOUR).padStart(2, "0")}:30:00Z`);

  it("is silent when the day is complete", async () => {
    const s = setup(async () => summary(), { start: evening });
    s.status.write({ ...emptyStatus(DAY), state: "complete" });
    expect((await runDailyMcp(s.deps("watchdog"))).outcome).toBe("watchdog-ok");
    expect(s.alerts.alerts).toEqual([]);
  });

  it("alerts when the snapshot is in and the sessions are not", async () => {
    const s = setup(async () => summary(), { start: evening });
    expect((await runDailyMcp(s.deps("watchdog"))).outcome).toBe("watchdog-alert");
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "mcp-not-complete", window: DAY });
    expect(s.calls.n).toBe(0);
  });

  it("does not judge a day before the evening, as the machine may only just have woken (the snapshot's false alert of 2026-10-19)", async () => {
    const s = setup(async () => summary(), { start: new Date(`${DAY}T06:00:00Z`) });
    expect((await runDailyMcp(s.deps("watchdog"))).outcome).toBe("watchdog-early");
    expect(s.alerts.alerts).toEqual([]);
  });

  it("says nothing when there is no snapshot, because then there is no MCP day: the snapshot's own check reports that", async () => {
    const s = setup(async () => summary(), { start: evening, snapshotComplete: false });
    expect((await runDailyMcp(s.deps("watchdog"))).outcome).toBe("watchdog-snapshot-not-complete");
    expect(s.alerts.alerts).toEqual([]);
  });

  it("never judges while a run holds the lock", async () => {
    const s = setup(async () => summary(), { start: evening });
    const held = acquireLock(join(s.home, "locks", "live.lock"), "daily-mcp");
    try {
      expect((await runDailyMcp(s.deps("watchdog"))).outcome).toBe("watchdog-running");
    } finally {
      held.release();
    }
    expect(s.alerts.alerts).toEqual([]);
  });
});
