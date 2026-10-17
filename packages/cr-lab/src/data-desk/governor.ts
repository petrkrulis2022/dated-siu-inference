/**
 * The rate-limit governor (§16.5). The docs document NO rate limit, but the live API does answer `429 Too Many Requests` with no `Retry-After` and no rate-limit headers (seen on
 * 2026-10-17: after about 25 requests in 95 seconds at one a second, and again on the second request of a later pair six seconds apart), so the limit is not known and the defaults
 * are conservative. Per group (`data-api`, `token-unlocks`, `mcp`):
 *  - requests run `maxConcurrent` at a time (1), first come first served, at least the group's CURRENT spacing apart. The spacing starts at `minIntervalMs` and **doubles after every
 *    429 (up to `maxSpacingMs`) and halves again after ten answers in a row that were not 429**, so the governor finds a pace the server accepts and then creeps back;
 *  - every attempt, retries included, counts against `maxRequestsPerHour` (a rolling hour) and `maxRequestsPerDay` (UTC); at either limit it throws instead of sending, so a limit is
 *    never exceeded;
 *  - a 429, 502, 503 or 504 backs off (the larger of `Retry-After` and an exponential step, capped) and retries up to `maxRetries`, then throws `RateLimited`.
 * Every attempt's status is kept (`attempts`) and everything it waited for or refused is reported, never silent. Time and sleeping are injected, so tests run without waiting.
 */
export interface GovernorConfig {
  maxConcurrent: number;
  /** The spacing between requests when nothing is going wrong. */
  minIntervalMs: number;
  /** The most the spacing is allowed to grow to after repeated 429s. */
  maxSpacingMs: number;
  maxRequestsPerHour: number;
  maxRequestsPerDay: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

/** Until the provisioning email says otherwise. */
export const DEFAULT_GOVERNOR: GovernorConfig = {
  maxConcurrent: 1,
  minIntervalMs: 5_000,
  maxSpacingMs: 60_000,
  maxRequestsPerHour: 30,
  maxRequestsPerDay: 200,
  maxRetries: 4,
  baseBackoffMs: 30_000,
  maxBackoffMs: 300_000,
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
  | { kind: "hourly-limit"; group: string; at: string; limit: number }
  | { kind: "daily-limit"; group: string; at: string; limit: number };

/** One request as the server answered it, kept so a rate-limit episode can be reconstructed afterwards. */
export interface Attempt {
  group: string;
  at: string;
  status: number;
}

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

export class HourlyRequestLimit extends Error {
  constructor(
    readonly group: string,
    readonly limit: number,
  ) {
    super(
      `${group} has reached its limit of ${limit} requests in the last hour; stopping instead of sending more`,
    );
    this.name = "HourlyRequestLimit";
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
  /** when each request in the last hour started */
  recent: number[];
  spacingMs: number;
  calmStreak: number;
}

export class RateGovernor {
  readonly #groups = new Map<string, GroupState>();
  readonly #overrides: Readonly<Record<string, Partial<GovernorConfig>>>;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly events: GovernorEvent[] = [];
  readonly attempts: Attempt[] = [];

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
      const config = { ...DEFAULT_GOVERNOR, ...this.#overrides[group] };
      s = {
        config,
        inFlight: 0,
        lastStart: Number.NEGATIVE_INFINITY,
        queue: [],
        day: "",
        requestsToday: 0,
        recent: [],
        spacingMs: config.minIntervalMs,
        calmStreak: 0,
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
        const wait = s.lastStart + s.spacingMs - this.#now();
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
        s.recent = s.recent.filter((t) => t > this.#now() - 3_600_000);
        if (s.recent.length >= s.config.maxRequestsPerHour) {
          this.events.push({
            kind: "hourly-limit",
            group,
            at: new Date(this.#now()).toISOString(),
            limit: s.config.maxRequestsPerHour,
          });
          throw new HourlyRequestLimit(group, s.config.maxRequestsPerHour);
        }
        s.requestsToday++;
        s.lastStart = this.#now();
        s.recent.push(s.lastStart);
        const result = await fn();
        this.attempts.push({
          group,
          at: new Date(this.#now()).toISOString(),
          status: result.status,
        });
        if (result.status === 429) {
          s.spacingMs = Math.min(Math.max(s.spacingMs, 1_000) * 2, s.config.maxSpacingMs);
          s.calmStreak = 0;
        } else if (++s.calmStreak >= 10) {
          s.spacingMs = Math.max(s.config.minIntervalMs, Math.floor(s.spacingMs / 2));
          s.calmStreak = 0;
        }
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

  /** What the governor did, for the daily report: requests per group, the pace it settled on, back-offs, 429s, and total time waited. */
  report(): {
    group: string;
    requestsToday: number;
    limit: number;
    hourlyLimit: number;
    spacingMs: number;
    backoffs: number;
    tooManyRequests: number;
    spacingWaits: number;
    waitedMs: number;
  }[] {
    return [...this.#groups.entries()].map(([group, s]) => {
      const mine = this.events.filter((e) => e.group === group);
      return {
        group,
        requestsToday: s.requestsToday,
        limit: s.config.maxRequestsPerDay,
        hourlyLimit: s.config.maxRequestsPerHour,
        spacingMs: s.spacingMs,
        backoffs: mine.filter((e) => e.kind === "backoff").length,
        tooManyRequests: this.attempts.filter((a) => a.group === group && a.status === 429).length,
        spacingWaits: mine.filter((e) => e.kind === "spacing").length,
        waitedMs: mine.reduce(
          (sum, e) =>
            sum + (e.kind === "daily-limit" || e.kind === "hourly-limit" ? 0 : e.waitedMs),
          0,
        ),
      };
    });
  }
}
