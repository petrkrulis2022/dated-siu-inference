/**
 * The trial's spend ledger and the guard in front of every paid call (D72, D73, §16.11).
 *
 *   const result = await ledger.guard("anthropic", "0.04", { part: "snapshot", model, key, what }, async () => ({ usd: "0.0311", ... }));
 *
 * `guard` reserves the projected cost against the daily cap and the provider's budget **before** the call, runs it, then records the provider's real figure
 * and releases the reservation. A refused call never starts and throws `SpendStopped` (with the reason), so the runner stops and reports instead of spending.
 * Reservations are counted until settled, and `reserve` is synchronous, so calls started together cannot jointly overshoot a limit.
 *
 * Known limit: reservations live in this process. Two processes spending at once (a snapshot run beside a development window) each see the other's *recorded*
 * spend but not its in-flight calls, so the cap can be overshot by at most those calls. Run one spending process at a time.
 */
import { D } from "@touchstone/sdk";
import type { Provider } from "../keys.js";
import { checkSpend, utcDay, type SpendCheck, type StopCode } from "./check.js";
import { fmtUsd, parseUsd } from "./money.js";
import { MemoryLedgerStore, validateEntry, type LedgerStore } from "./store.js";
import type { Part, Pending, SpendEntry, SpendPolicy } from "./types.js";
import { PROVIDERS } from "../keys.js";

export class SpendStopped extends Error {
  readonly code: StopCode;
  readonly reason: string;
  readonly provider: Provider;
  constructor(provider: Provider, check: Extract<SpendCheck, { ok: false }>) {
    super(`SPEND GUARD (${check.code}): ${check.reason}`);
    this.name = "SpendStopped";
    this.code = check.code;
    this.reason = check.reason;
    this.provider = provider;
  }
}

export interface Reservation {
  readonly id: number;
  readonly provider: Provider;
  readonly usd: string;
}

export interface SpendMeta {
  part: Part;
  model: string;
  /** The `.env` name of the key that pays, e.g. `CR_ANTHROPIC_API_KEY`. */
  key: string;
  what: string;
}

/** An error a provider adapter can throw when a call failed AFTER being billed (a timeout on a completed generation), so `guard` records the spend. */
export class SpendIncurred extends Error {
  constructor(
    readonly usd: string,
    message: string,
    /** the error the failed call actually raised, for whoever classifies the failure */
    readonly cause?: unknown,
    /** what the billed call used, for the record of the attempt */
    readonly usage?: { input: number; output: number; cached_input: number; reasoning: number },
  ) {
    super(message);
    this.name = "SpendIncurred";
  }
}

export interface SpendReport {
  day: string;
  dailyCapUsd: string;
  spentToday: string;
  remainingToday: string;
  providers: {
    provider: Provider;
    budgetUsd: string | null;
    since: string | null;
    spentUsd: string;
    remainingUsd: string | null;
  }[];
  todayByPart: Partial<Record<Part, string>>;
}

export class SpendLedger {
  readonly #store: LedgerStore;
  readonly #policy: SpendPolicy;
  readonly #now: () => Date;
  readonly #pending = new Map<number, Pending>();
  #seq = 0;

  constructor(opts: { store?: LedgerStore; policy: SpendPolicy; now?: () => Date }) {
    this.#store = opts.store ?? new MemoryLedgerStore();
    this.#policy = opts.policy;
    this.#now = opts.now ?? (() => new Date());
  }

  /** The check a call would face now, without reserving anything. */
  check(provider: Provider, projectedUsd: string): SpendCheck {
    return checkSpend({
      entries: this.#store.load(),
      pending: [...this.#pending.values()],
      now: this.#now(),
      provider,
      projectedUsd,
      policy: this.#policy,
    });
  }

  /** Allows a call and counts its projected cost until it is settled or released. Throws `SpendStopped` if either limit would be crossed. */
  reserve(provider: Provider, projectedUsd: string): Reservation {
    const check = this.check(provider, projectedUsd);
    if (!check.ok) throw new SpendStopped(provider, check);
    const reservation: Reservation = { id: ++this.#seq, provider, usd: projectedUsd };
    this.#pending.set(reservation.id, { provider, usd: projectedUsd });
    return reservation;
  }

  /** Records what a call really cost and releases its reservation. The real figure may exceed the projection; it is recorded as it is and the next call sees it. */
  settle(reservation: Reservation, actualUsd: string, meta: SpendMeta): SpendEntry {
    parseUsd(actualUsd, "actualUsd");
    const entry = validateEntry({
      at: this.#now().toISOString(),
      provider: reservation.provider,
      usd: fmtUsd(new D(actualUsd)),
      ...meta,
    });
    this.#store.append(entry);
    this.#pending.delete(reservation.id);
    return entry;
  }

  /** Releases a reservation for a call that spent nothing (it failed before the provider billed). */
  release(reservation: Reservation): void {
    this.#pending.delete(reservation.id);
  }

  /**
   * Reserve, run, settle. `fn` returns the call's real cost as `usd`. If `fn` throws, the reservation is released and nothing is recorded, unless the error is a
   * `SpendIncurred`, which records its `usd` first.
   */
  async guard<T extends { usd: string }>(
    provider: Provider,
    projectedUsd: string,
    meta: SpendMeta,
    fn: () => Promise<T>,
  ): Promise<T> {
    const reservation = this.reserve(provider, projectedUsd);
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      if (err instanceof SpendIncurred) this.settle(reservation, err.usd, meta);
      else this.release(reservation);
      throw err;
    }
    this.settle(reservation, result.usd, meta);
    return result;
  }

  report(): SpendReport {
    const now = this.#now();
    const day = utcDay(now);
    const entries = this.#store.load();
    const today = entries.filter((e) => utcDay(new Date(e.at)) === day);
    const sum = (rows: readonly { usd: string }[]) =>
      rows.reduce((acc, r) => acc.plus(r.usd), new D(0));
    const spentToday = sum(today);
    const cap = parseUsd(this.#policy.dailyCapUsd, "dailyCapUsd");
    const todayByPart: Partial<Record<Part, string>> = {};
    for (const e of today)
      todayByPart[e.part] = fmtUsd(new D(todayByPart[e.part] ?? "0").plus(e.usd));
    return {
      day,
      dailyCapUsd: cap.toFixed(2),
      spentToday: fmtUsd(spentToday),
      remainingToday: fmtUsd(cap.minus(spentToday)),
      todayByPart,
      providers: PROVIDERS.map((provider) => {
        const budget = this.#policy.providers[provider];
        const since = budget === undefined ? 0 : new Date(budget.since).getTime();
        const spent = sum(
          entries.filter((e) => e.provider === provider && new Date(e.at).getTime() >= since),
        );
        return {
          provider,
          budgetUsd: budget?.budgetUsd ?? null,
          since: budget?.since ?? null,
          spentUsd: fmtUsd(spent),
          remainingUsd:
            budget === undefined
              ? null
              : fmtUsd(parseUsd(budget.budgetUsd, "budgetUsd").minus(spent)),
        };
      }),
    };
  }
}
