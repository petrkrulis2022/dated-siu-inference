/**
 * What happened on each UTC day's snapshot, one small JSON file per window under the private directory. It records outcomes and counts, never a figure from Blockworks, and it is how a
 * later run knows the day is already done (so an hourly schedule costs no requests once the day is complete), how many requests the day has used across attempts (the governor's own count
 * is per process), and which alerts were already sent (so a failing day does not alert every hour).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathWithin, privatePath } from "../paths.js";
import { assertWindowAndTag } from "../data-desk/snapshots.js";

export type AlertKind =
  "pull-failed" | "not-complete" | "yesterday-missing" | "lock-stuck" | "request-ceiling";

export interface AttemptRecord {
  at: string;
  outcome: "complete" | "failed" | "error";
  pulled: number;
  fromStore: number;
  failed: number;
  /** requests this attempt sent */
  requests: number;
  /** step names that failed, never their data */
  failedSteps: string[];
  /** the class of an unexpected error, never its message */
  error?: string;
}

export interface DayStatus {
  window: string;
  state: "complete" | "incomplete";
  completedAt?: string;
  attempts: AttemptRecord[];
  /** when each kind of alert was last raised for this window */
  alerts: Partial<Record<AlertKind, string>>;
}

export const emptyStatus = (window: string): DayStatus => ({
  window,
  state: "incomplete",
  attempts: [],
  alerts: {},
});

export class StatusStore {
  readonly #dir: string;
  constructor(dir?: string) {
    this.#dir = dir ?? privatePath("cr", "status");
  }
  #file(window: string): string {
    assertWindowAndTag(window, "daily");
    return pathWithin(this.#dir, `${window}.json`);
  }
  read(window: string): DayStatus | undefined {
    try {
      return JSON.parse(readFileSync(this.#file(window), "utf-8")) as DayStatus;
    } catch {
      return undefined;
    }
  }
  /** every window that has a status file, ascending */
  windows(): string[] {
    if (!existsSync(this.#dir)) return [];
    return readdirSync(this.#dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n))
      .map((n) => n.slice(0, 10))
      .sort();
  }
  write(status: DayStatus): void {
    const f = this.#file(status.window);
    mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, f);
  }
}

export const requestsUsed = (s: DayStatus): number =>
  s.attempts.reduce((n, a) => n + a.requests, 0);
