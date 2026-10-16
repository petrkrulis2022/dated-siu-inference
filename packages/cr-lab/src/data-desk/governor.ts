/**
 * The rate-limit governor (§16.5). The Data API documents NO rate limit (no `RateLimit-*` or `Retry-After` headers, no 429), and neither do the Token Unlocks API or the MCP,
 * so until Blockworks' provisioning email gives limits the defaults are conservative, and the governor is configured per group (`data-api`, `token-unlocks`, `mcp`):
 *  - requests in a group run `maxConcurrent` at a time (1), at least `minIntervalMs` apart (1,000 ms), first come first served;
 *  - every attempt, retries included, counts against `maxRequestsPerDay` (UTC day); at the limit it throws instead of sending, so a limit is never exceeded;
 *  - a 429, 502, 503 or 504 backs off (the larger of `Retry-After` and an exponential step, capped) and retries up to `maxRetries`, then throws `RateLimited`.
 * Everything it waits for or refuses is recorded and reported, never silent. Time and sleeping are injected, so tests run without waiting.
 */
export interface GovernorConfig {
  maxConcurrent: number;
  minIntervalMs: number;
  maxRequestsPerDay: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/** Until the provisioning email says otherwise. */
export const DEFAULT_GOVERNOR: GovernorConfig = {
  maxConcurrent: 1,
  minIntervalMs: 1_000,
  maxRequestsPerDay: 200,
  maxRetries: 4,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000,
};

export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

export type GovernorEvent =
  | { kind: "spacing"; group: string; at: string; waitedMs: number }
  | {
      kind: "backoff";
      group: string;
      at: string;
      status: number;
      attempt: number;
      waitedMs: number;
    }
  | { kind: "daily-limit"; group: string; at: string; limit: number };

export class RateLimited extends Error {
  constructor(
    readonly group: string,
    readonly status: number,
    attempts: number,
  ) {
    super(
      `${group} still answered ${status} after ${attempts} attempts; stopping instead of sending more`,
    );
    this.name = "RateLimited";
  }
}

export class DailyRequestLimit extends Error {
  constructor(
    readonly group: string,
    readonly limit: number,
  ) {
    super(
      `${group} has reached its limit of ${limit} requests today (UTC); stopping instead of sending more`,
    );
    this.name = "DailyRequestLimit";
  }
}

export interface GovernedResult<T> {
  status: number;
  retryAfterSeconds?: number;
  value: T;
}

interface GroupState {
  config: GovernorConfig;
  inFlight: number;
  lastStart: number;
  queue: (() => void)[];
  day: string;
  requestsToday: number;
}

export class RateGovernor {
  readonly #groups = new Map<string, GroupState>();
  readonly #overrides: Readonly<Record<string, Partial<GovernorConfig>>>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly events: GovernorEvent[] = [];

  constructor(
    opts: {
      overrides?: Record<string, Partial<GovernorConfig>>;
      now?: () => number;
      sleep?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.#overrides = opts.overrides ?? {};
    this.#now = opts.now ?? (() => Date.now());
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  #state(group: string): GroupState {
    let s = this.#groups.get(group);
    if (s === undefined) {
      s = {
        config: { ...DEFAULT_GOVERNOR, ...this.#overrides[group] },
        inFlight: 0,
        lastStart: Number.NEGATIVE_INFINITY,
        queue: [],
        day: "",
        requestsToday: 0,
      };
      this.#groups.set(group, s);
    }
    return s;
  }

  async #acquire(s: GroupState): Promise<void> {
    if (s.inFlight >= s.config.maxConcurrent)
      await new Promise<void>((resolve) => s.queue.push(resolve));
    else s.inFlight++;
  }

  #release(s: GroupState): void {
    const next = s.queue.shift();
    if (next === undefined) s.inFlight--;
    else next(); // the slot passes straight to the next caller in line
  }

  /** Runs `fn` under the group's limits. `fn` returns the HTTP status (and `Retry-After`, if any) with its value; a retryable status is retried after a back-off. */
  async run<T>(group: string, fn: () => Promise<GovernedResult<T>>): Promise<T> {
    const s = this.#state(group);
    await this.#acquire(s);
    try {
      for (let attempt = 0; ; attempt++) {
        const wait = s.lastStart + s.config.minIntervalMs - this.#now();
        if (wait > 0) {
          this.events.push({
            kind: "spacing",
            group,
            at: new Date(this.#now()).toISOString(),
            waitedMs: wait,
          });
          await this.#sleep(wait);
        }
        const day = new Date(this.#now()).toISOString().slice(0, 10);
        if (s.day !== day) {
          s.day = day;
          s.requestsToday = 0;
        }
        if (s.requestsToday >= s.config.maxRequestsPerDay) {
          this.events.push({
            kind: "daily-limit",
            group,
            at: new Date(this.#now()).toISOString(),
            limit: s.config.maxRequestsPerDay,
          });
          throw new DailyRequestLimit(group, s.config.maxRequestsPerDay);
        }
        s.requestsToday++;
        s.lastStart = this.#now();
        const result = await fn();
        if (!RETRYABLE_STATUS.has(result.status)) return result.value;
        if (attempt >= s.config.maxRetries)
          throw new RateLimited(group, result.status, attempt + 1);
        const step = Math.min(s.config.baseBackoffMs * 2 ** attempt, s.config.maxBackoffMs);
        const waitedMs = Math.min(
          Math.max(step, (result.retryAfterSeconds ?? 0) * 1_000),
          s.config.maxBackoffMs,
        );
        this.events.push({
          kind: "backoff",
          group,
          at: new Date(this.#now()).toISOString(),
          status: result.status,
          attempt: attempt + 1,
          waitedMs,
        });
        await this.#sleep(waitedMs);
      }
    } finally {
      this.#release(s);
    }
  }

  /** What the governor did, for the daily report: requests per group today, back-offs, and total time waited. */
  report(): {
    group: string;
    requestsToday: number;
    limit: number;
    backoffs: number;
    spacingWaits: number;
    waitedMs: number;
  }[] {
    return [...this.#groups.entries()].map(([group, s]) => {
      const mine = this.events.filter((e) => e.group === group);
      return {
        group,
        requestsToday: s.requestsToday,
        limit: s.config.maxRequestsPerDay,
        backoffs: mine.filter((e) => e.kind === "backoff").length,
        spacingWaits: mine.filter((e) => e.kind === "spacing").length,
        waitedMs: mine.reduce((sum, e) => sum + (e.kind === "daily-limit" ? 0 : e.waitedMs), 0),
      };
    });
  }
}
