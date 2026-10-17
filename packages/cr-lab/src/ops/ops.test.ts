import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SnapshotRunResult } from "../data-desk/snapshot-run.js";
import { MemoryAlertSink, FileAlertSink, ToastAlertSink } from "./alert.js";
import {
  ALERT_GAP_MS,
  REQUEST_CEILING,
  STUCK_LOCK_MS,
  runDailySnapshot,
  type DailyDeps,
} from "./daily-snapshot.js";
import { LockHeld, acquireLock, lockOwner } from "./lock.js";
import { StatusStore, emptyStatus } from "./status.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-ops-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("the shared lock", () => {
  const lockPath = () => join(tmp, "locks", "x.lock");
  const dead = { isAlive: () => false, bootId: () => "boot-1" };
  const alive = { isAlive: () => true, bootId: () => "boot-1" };

  it("is taken once: a second taker is refused while the owner lives", () => {
    const a = acquireLock(lockPath(), "one", { ...alive, pid: 111 });
    expect(() => acquireLock(lockPath(), "two", { ...alive, pid: 222 })).toThrow(LockHeld);
    try {
      acquireLock(lockPath(), "two", { ...alive, pid: 222 });
    } catch (e) {
      expect((e as LockHeld).info).toMatchObject({ pid: 111, label: "one" });
    }
    a.release();
    expect(() => acquireLock(lockPath(), "two", { ...alive, pid: 222 }).release()).not.toThrow();
  });

  it("takes over a lock whose owner is dead", () => {
    acquireLock(lockPath(), "old", { ...alive, pid: 111 });
    const t = acquireLock(lockPath(), "new", { ...dead, pid: 222 });
    expect(t.info.pid).toBe(222);
    t.release();
  });

  it("takes over a lock written before the last restart, even if its pid is alive again (pids are reused)", () => {
    acquireLock(lockPath(), "older", { isAlive: () => true, bootId: () => "boot-1", pid: 333 });
    const t = acquireLock(lockPath(), "after-restart", {
      isAlive: () => true,
      bootId: () => "boot-2",
      pid: 444,
    });
    expect(t.info.pid).toBe(444);
  });

  it("never takes over a live owner however old the lock is", () => {
    const old = new Date("2026-01-01T00:00:00Z");
    acquireLock(lockPath(), "ancient", { ...alive, pid: 111, now: () => old });
    expect(() => acquireLock(lockPath(), "new", { ...alive, pid: 222 })).toThrow(LockHeld);
  });

  it("treats an unreadable lock file as stale", () => {
    const p = join(tmp, "locks", "y.lock");
    acquireLock(p, "seed", { ...alive, pid: 1 }).release();
    writeFileSync(p, "{half");
    expect(acquireLock(p, "me", { ...alive, pid: 2 }).info.pid).toBe(2);
  });

  it("release removes only the lock its own holder took", () => {
    const p = join(tmp, "locks", "z.lock");
    const a = acquireLock(p, "a", { ...alive, pid: 5 });
    rmSync(p);
    const b = acquireLock(p, "b", { ...alive, pid: 6 });
    a.release(); // a no longer owns it: must not delete b's lock
    expect(lockOwner(p, alive)?.label).toBe("b");
    b.release();
    expect(lockOwner(p, alive)).toBeUndefined();
  });
});

const T0 = new Date("2026-10-18T04:00:00Z");
const clock = (start: Date) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t = new Date(t.getTime() + ms)) };
};
const okRun = (over: Partial<SnapshotRunResult> = {}): SnapshotRunResult => ({
  result: {
    window: "2026-10-18",
    steps: [{ step: "perp", ok: true }],
    pulled: 40,
    fromStore: 0,
    failed: 0,
  },
  governor: [],
  requests: 41,
  ...over,
});
const failRun = (): SnapshotRunResult => ({
  result: {
    window: "2026-10-18",
    steps: [
      { step: "lending batch 3", ok: false, error: "429" },
      { step: "unlocks", ok: false, error: "boom" },
    ],
    pulled: 30,
    fromStore: 0,
    failed: 2,
  },
  governor: [],
  requests: 33,
});

let seq = 0;
function setup(pull: DailyDeps["pull"], start = T0) {
  const c = clock(start);
  const alerts = new MemoryAlertSink();
  const home = join(tmp, `world-${++seq}`);
  const status = new StatusStore(join(home, "status"));
  const calls = { n: 0 };
  const deps = (mode: "pull" | "watchdog" = "pull"): DailyDeps => ({
    mode,
    status,
    alerts,
    lockPath: join(home, "locks", "live.lock"),
    pull: async (w, l) => {
      calls.n += 1;
      return pull(w, l);
    },
    now: c.now,
    lockDeps: { isAlive: () => true, bootId: () => "b" },
  });
  return { c, alerts, status, calls, deps };
}

describe("the scheduled daily snapshot", () => {
  it("pulls an incomplete day, records it, and the next hourly run does nothing and sends no request", async () => {
    const s = setup(async () => okRun());
    expect((await runDailySnapshot(s.deps())).outcome).toBe("complete");
    expect(s.status.read("2026-10-18")).toMatchObject({
      state: "complete",
      attempts: [{ outcome: "complete", requests: 41 }],
    });
    s.c.advance(3_600_000);
    expect((await runDailySnapshot(s.deps())).outcome).toBe("already-complete");
    s.c.advance(3_600_000);
    expect((await runDailySnapshot(s.deps())).outcome).toBe("already-complete");
    expect(s.calls.n).toBe(1);
    expect(s.alerts.alerts).toEqual([]);
  });

  it("catches up: a run at 11:00 after the machine slept through the morning still pulls that UTC day", async () => {
    const s = setup(async () => okRun(), new Date("2026-10-18T11:07:00Z"));
    expect((await runDailySnapshot(s.deps())).outcome).toBe("complete");
    expect(s.calls.n).toBe(1);
  });

  it("holds the lock while pulling: a second run started during a pull does not pull, and the lock is released afterwards", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = setup(async () => {
      await gate;
      return okRun();
    });
    const first = runDailySnapshot(s.deps());
    await new Promise((r) => setTimeout(r, 20));
    expect((await runDailySnapshot(s.deps())).outcome).toBe("already-running");
    expect(s.calls.n).toBe(1);
    release();
    expect((await first).outcome).toBe("complete");
    expect(
      lockOwner(join(tmp, `world-${seq}`, "locks", "live.lock"), {
        isAlive: () => true,
        bootId: () => "b",
      }),
    ).toBeUndefined();
  });

  it("releases the lock even when the pull throws, and records only the error's class", async () => {
    const s = setup(async () => {
      throw Object.assign(new Error("secret body 12345"), { name: "RateLimited" });
    });
    expect((await runDailySnapshot(s.deps())).outcome).toBe("failed");
    const st = s.status.read("2026-10-18");
    expect(st?.attempts[0]).toMatchObject({ outcome: "error", error: "RateLimited" });
    expect(JSON.stringify(st)).not.toContain("secret");
    expect(s.alerts.alerts[0]?.message).toContain("RateLimited");
    expect(JSON.stringify(s.alerts.alerts)).not.toContain("secret");
    expect((await runDailySnapshot({ ...s.deps(), pull: async () => okRun() })).outcome).toBe(
      "complete",
    );
  });

  it("alerts when steps fail, naming them, and not again for six hours", async () => {
    const s = setup(async () => failRun());
    expect((await runDailySnapshot(s.deps())).outcome).toBe("failed");
    expect(s.alerts.alerts).toHaveLength(1);
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "pull-failed", window: "2026-10-18" });
    expect(s.alerts.alerts[0]?.message).toContain("lending batch 3");
    s.c.advance(3_600_000);
    await runDailySnapshot(s.deps());
    expect(s.alerts.alerts).toHaveLength(1); // suppressed: same kind, same window, inside the gap
    s.c.advance(ALERT_GAP_MS);
    await runDailySnapshot(s.deps());
    expect(s.alerts.alerts).toHaveLength(2);
    expect(s.status.read("2026-10-18")?.state).toBe("incomplete");
  });

  it("stops at the request ceiling across attempts, which the governor's per-process count cannot see", async () => {
    const heavy = (): SnapshotRunResult => ({ ...failRun(), requests: REQUEST_CEILING });
    const s = setup(async () => heavy());
    await runDailySnapshot(s.deps());
    s.c.advance(ALERT_GAP_MS + 1);
    expect((await runDailySnapshot(s.deps())).outcome).toBe("request-ceiling");
    expect(s.calls.n).toBe(1);
    expect(s.alerts.alerts.map((a) => a.kind)).toContain("request-ceiling");
  });

  it("the evening watchdog is silent for a complete day and alerts for an incomplete one, without pulling", async () => {
    const s = setup(async () => okRun());
    await runDailySnapshot(s.deps());
    s.c.advance(17 * 3_600_000);
    expect((await runDailySnapshot(s.deps("watchdog"))).outcome).toBe("watchdog-ok");
    const t = setup(async () => okRun());
    expect((await runDailySnapshot(t.deps("watchdog"))).outcome).toBe("watchdog-alert");
    expect(t.alerts.alerts[0]).toMatchObject({ kind: "not-complete", window: "2026-10-18" });
    expect(t.calls.n).toBe(0);
  });

  it("says a missed day cannot be recovered, once, for every day missed since the schedule first ran", async () => {
    const s = setup(async () => okRun(), new Date("2026-10-18T04:00:00Z"));
    await runDailySnapshot(s.deps()); // day 1 complete
    s.c.advance(3 * 24 * 3_600_000); // the machine was off on the 19th and the 20th; now it is the 21st
    await runDailySnapshot(s.deps());
    const missed = s.alerts.alerts
      .filter((a) => a.kind === "yesterday-missing")
      .map((a) => a.window);
    expect(missed).toEqual(["2026-10-19", "2026-10-20"]);
    expect(s.alerts.alerts[0]?.message).toContain("cannot be recovered");
    s.c.advance(3_600_000);
    await runDailySnapshot(s.deps());
    expect(s.alerts.alerts.filter((a) => a.kind === "yesterday-missing")).toHaveLength(2); // once each
  });

  it("is silent on the very first day of use: nothing earlier is reported missing", async () => {
    const s = setup(async () => okRun());
    await runDailySnapshot(s.deps());
    expect(s.alerts.alerts).toEqual([]);
  });

  it("reports a lock held by a live process for hours as stuck, but never takes it", async () => {
    const s = setup(async () => okRun());
    acquireLock(join(tmp, `world-${seq}`, "locks", "live.lock"), "hung", {
      pid: 99,
      isAlive: () => true,
      bootId: () => "b",
      now: () => new Date(T0.getTime() - STUCK_LOCK_MS - 60_000),
    });
    expect((await runDailySnapshot(s.deps())).outcome).toBe("already-running");
    expect(s.alerts.alerts[0]).toMatchObject({ kind: "lock-stuck" });
    expect(s.calls.n).toBe(0);
  });
});

describe("alert sinks", () => {
  const alert = {
    at: "2026-10-18T04:00:00.000Z",
    kind: "pull-failed" as const,
    window: "2026-10-18",
    message: "it's failing",
  };

  it("the file sink appends one JSON line per alert", async () => {
    const p = join(tmp, "a", "alerts.jsonl");
    const sink = new FileAlertSink(p);
    await sink.send(alert);
    await sink.send({ ...alert, kind: "not-complete" });
    const lines = readFileSync(p, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["pull-failed", "not-complete"]);
  });

  it("the toast sink escapes quotes, is off outside Windows, and never throws", async () => {
    const scripts: string[] = [];
    await new ToastAlertSink({ enabled: true, run: async (s) => void scripts.push(s) }).send(alert);
    expect(scripts[0]).toContain("it''s failing");
    await new ToastAlertSink({ enabled: false, run: async (s) => void scripts.push(s) }).send(
      alert,
    );
    expect(scripts).toHaveLength(1);
    await expect(
      new ToastAlertSink({
        enabled: true,
        run: async () => {
          throw new Error("no powershell");
        },
      }).send(alert),
    ).resolves.toBeUndefined();
  });

  it("a status for a window starts incomplete and empty", () => {
    expect(emptyStatus("2026-10-18")).toEqual({
      window: "2026-10-18",
      state: "incomplete",
      attempts: [],
      alerts: {},
    });
  });
});
