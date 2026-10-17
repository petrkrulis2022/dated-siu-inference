/**
 * The one lock every live Blockworks process takes (the daily snapshot, and later MCP mode), so two can never overlap: the rate governor counts requests per process, so two processes
 * would each think they were within the limit while together exceeding it.
 *
 * The lock is a file created exclusively (`wx`), holding the owner's pid, the boot id and the start time. It is held while the pid is alive in the same boot; a lock whose pid is dead, or
 * that was written before the last restart of this machine (a different boot id: pids are reused after a restart), is stale and is taken over. A live owner is never taken over, however
 * old the lock: an old live lock is reported instead (a hung pull needs a person, or the scheduler's own time limit, not a second process).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface LockInfo {
  pid: number;
  bootId: string;
  startedAt: string;
  label: string;
}

export class LockHeld extends Error {
  constructor(readonly info: LockInfo) {
    super(`held by ${info.label} (pid ${info.pid}) since ${info.startedAt}`);
    this.name = "LockHeld";
  }
}

export interface LockDeps {
  now?: () => Date;
  pid?: number;
  bootId?: () => string;
  isAlive?: (pid: number) => boolean;
}

const defaultBootId = (): string => {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim();
  } catch {
    return "unknown";
  }
};
const defaultIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

function read(path: string): LockInfo | undefined {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockInfo>;
    if (typeof v.pid === "number" && typeof v.startedAt === "string")
      return { pid: v.pid, bootId: v.bootId ?? "", startedAt: v.startedAt, label: v.label ?? "?" };
  } catch {
    /* unreadable or half-written: treated as stale below */
  }
  return undefined;
}

export interface Lock {
  readonly info: LockInfo;
  release(): void;
}

/** Takes the lock, or throws `LockHeld` naming the live owner. A stale lock is removed first. */
export function acquireLock(path: string, label: string, deps: LockDeps = {}): Lock {
  const now = deps.now ?? (() => new Date());
  const boot = (deps.bootId ?? defaultBootId)();
  const alive = deps.isAlive ?? defaultIsAlive;
  const info: LockInfo = {
    pid: deps.pid ?? process.pid,
    bootId: boot,
    startedAt: now().toISOString(),
    label,
  };
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(info)}\n`, { flag: "wx", mode: 0o600 });
      return {
        info,
        release: () => {
          const cur = read(path);
          if (cur !== undefined && cur.pid === info.pid && cur.startedAt === info.startedAt)
            rmSync(path, { force: true });
        },
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const held = read(path);
      const stale = held === undefined || held.bootId !== boot || !alive(held.pid);
      if (!stale) throw new LockHeld(held);
      rmSync(path, { force: true });
    }
  }
  const raced = read(path);
  if (raced !== undefined) throw new LockHeld(raced);
  throw new Error(`could not take the lock at ${path}`);
}

/** The lock's current live owner, without taking it. */
export function lockOwner(path: string, deps: LockDeps = {}): LockInfo | undefined {
  const held = read(path);
  if (held === undefined) return undefined;
  const boot = (deps.bootId ?? defaultBootId)();
  return held.bootId === boot && (deps.isAlive ?? defaultIsAlive)(held.pid) ? held : undefined;
}
