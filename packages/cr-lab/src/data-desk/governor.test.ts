import { describe, expect, it } from "vitest";
import {
  DEFAULT_GOVERNOR,
  DailyRequestLimit,
  HourlyRequestLimit,
  RateGovernor,
  RateLimited,
  type GovernedResult,
} from "./governor.js";

/** A clock that only moves when something sleeps, so tests are instant and exact. */
function fake(startIso = "2026-10-20T12:00:00Z") {
  let t = new Date(startIso).getTime();
  const slept: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    slept,
  };
}
const ok = <T>(value: T): GovernedResult<T> => ({ status: 200, value });

describe("RateGovernor", () => {
  it("spaces requests at least minIntervalMs apart, and does not wait for the first", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 1000 } },
    });
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) await g.run("data-api", async () => (starts.push(c.now()), ok(i)));
    expect(starts[1]! - starts[0]!).toBe(1000);
    expect(starts[2]! - starts[1]!).toBe(1000);
    expect(c.slept).toEqual([1000, 1000]);
  });

  it("defaults to a conservative pace, because the live API rate-limits and does not say where", () => {
    expect(DEFAULT_GOVERNOR).toMatchObject({
      maxConcurrent: 1,
      minIntervalMs: 5_000,
      maxRequestsPerHour: 30,
      maxRequestsPerDay: 200,
    });
  });

  it("never has two requests in flight when maxConcurrent is 1, and serves callers in the order they asked", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0 } },
    });
    let inFlight = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        g.run("data-api", async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await Promise.resolve();
          await Promise.resolve();
          order.push(n);
          inFlight--;
          return ok(n);
        }),
      ),
    );
    expect(peak).toBe(1);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it("allows more in flight only when configured to", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { x: { maxConcurrent: 2, minIntervalMs: 0 } },
    });
    let inFlight = 0;
    let peak = 0;
    await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        g.run("x", async () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 2));
          inFlight--;
          return ok(1);
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it("backs off on 429 and 503, honours a longer Retry-After, caps the wait, and reports each back-off", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: {
        "data-api": {
          minIntervalMs: 0,
          maxSpacingMs: 0,
          baseBackoffMs: 2_000,
          maxBackoffMs: 60_000,
          maxRetries: 4,
        },
      },
    });
    const answers: GovernedResult<string>[] = [
      { status: 429, value: "x", retryAfterSeconds: 10 },
      { status: 503, value: "x" },
      { status: 429, value: "x", retryAfterSeconds: 600 },
      ok("fine"),
    ];
    const out = await g.run("data-api", async () => answers.shift()!);
    expect(out).toBe("fine");
    expect(c.slept).toEqual([10_000, 4_000, 60_000]); // Retry-After 10s beats the 2s step; 503 takes the 4s step; 600s is capped at 60s
    expect(
      g.events.filter((e) => e.kind === "backoff").map((e) => e.kind === "backoff" && e.status),
    ).toEqual([429, 503, 429]);
    expect(g.report()[0]).toMatchObject({
      group: "data-api",
      requestsToday: 4,
      backoffs: 3,
      tooManyRequests: 2,
    });
  });

  it("gives up after maxRetries with RateLimited, instead of sending more", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0, maxRetries: 2 } },
    });
    let sent = 0;
    await expect(
      g.run("data-api", async () => (sent++, { status: 429, value: null })),
    ).rejects.toBeInstanceOf(RateLimited);
    expect(sent).toBe(3); // the first try and two retries
  });

  it("does not retry an ordinary error status: a 403 or 500 is returned for the caller to handle", async () => {
    const c = fake();
    const g = new RateGovernor({ now: c.now, sleep: c.sleep });
    for (const status of [400, 401, 403, 404, 500]) {
      let sent = 0;
      expect(await g.run("data-api", async () => (sent++, { status, value: status }))).toBe(status);
      expect(sent).toBe(1);
    }
  });

  it("stops at the daily request limit, counting retries, and starts a fresh count on the next UTC day", async () => {
    const c = fake("2026-10-20T23:59:00Z");
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0, maxRequestsPerDay: 3 } },
    });
    let sent = 0;
    const call = async () => (sent++, ok(1));
    await g.run("data-api", call);
    await g.run("data-api", call);
    await g.run("data-api", call);
    await expect(g.run("data-api", call)).rejects.toBeInstanceOf(DailyRequestLimit);
    expect(sent).toBe(3);
    expect(g.events.some((e) => e.kind === "daily-limit")).toBe(true);
    c.advance(2 * 60_000); // past midnight UTC
    await g.run("data-api", call);
    expect(sent).toBe(4);
  });

  it("keeps groups separate: one group's limits do not slow another", async () => {
    const c = fake();
    const g = new RateGovernor({ now: c.now, sleep: c.sleep });
    await g.run("data-api", async () => ok(1));
    await g.run("token-unlocks", async () => ok(1)); // first in its own group: no spacing wait
    expect(c.slept).toEqual([]);
  });

  it("releases its slot when a call throws, so the next caller is not stuck", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0 } },
    });
    await expect(g.run("data-api", async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom",
    );
    await expect(g.run("data-api", async () => ok("next"))).resolves.toBe("next");
  });

  it("doubles its spacing after a 429, up to the ceiling, and halves it again after ten calm answers", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: {
        "data-api": {
          minIntervalMs: 1_000,
          maxSpacingMs: 4_000,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
          maxRetries: 9,
          maxRequestsPerHour: 1_000,
        },
      },
    });
    const answers: GovernedResult<number>[] = [
      { status: 429, value: 0 },
      { status: 429, value: 0 },
      { status: 429, value: 0 },
      ok(1),
    ];
    await g.run("data-api", async () => answers.shift()!);
    expect(g.report()[0]?.spacingMs).toBe(4_000); // 1s, doubled to 2s, then 4s, held at the 4s ceiling
    for (let i = 0; i < 10; i++) await g.run("data-api", async () => ok(i));
    expect(g.report()[0]?.spacingMs).toBe(2_000); // ten answers that were not 429: halved
    for (let i = 0; i < 10; i++) await g.run("data-api", async () => ok(i));
    expect(g.report()[0]?.spacingMs).toBe(1_000); // and back to the configured pace, never below it
    for (let i = 0; i < 10; i++) await g.run("data-api", async () => ok(i));
    expect(g.report()[0]?.spacingMs).toBe(1_000);
  });

  it("really waits the wider spacing after a 429: the next request is not sent at the old pace", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: {
        "data-api": {
          minIntervalMs: 1_000,
          maxSpacingMs: 60_000,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
        },
      },
    });
    const starts: number[] = [];
    const answers: GovernedResult<number>[] = [{ status: 429, value: 0 }, ok(1), ok(2)];
    await g.run("data-api", async () => (starts.push(c.now()), answers.shift()!));
    await g.run("data-api", async () => (starts.push(c.now()), answers.shift()!));
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(2_000);
  });

  it("stops at the hourly limit, counting only the last hour, and carries on once the hour has moved on", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0, maxRequestsPerHour: 3 } },
    });
    const call = async () => ok(1);
    await g.run("data-api", call);
    c.advance(10 * 60_000);
    await g.run("data-api", call);
    await g.run("data-api", call);
    await expect(g.run("data-api", call)).rejects.toBeInstanceOf(HourlyRequestLimit);
    expect(g.events.some((e) => e.kind === "hourly-limit")).toBe(true);
    c.advance(51 * 60_000); // the first request is now more than an hour old
    await expect(g.run("data-api", call)).resolves.toBe(1);
  });

  it("keeps every attempt's status, with the time, so a rate-limit episode can be reconstructed afterwards", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0, baseBackoffMs: 1, maxBackoffMs: 1 } },
    });
    const answers: GovernedResult<string>[] = [
      { status: 429, value: "x" },
      { status: 503, value: "x" },
      ok("y"),
    ];
    await g.run("data-api", async () => answers.shift()!);
    expect(g.attempts.map((a) => a.status)).toEqual([429, 503, 200]);
    expect(g.attempts[0]).toMatchObject({
      group: "data-api",
      at: expect.stringMatching(/^2026-10-20T12:00:0/),
    });
  });

  it("waits out the hourly limit instead of stopping when told to, and reports the wait", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: {
        "data-api": { minIntervalMs: 0, maxRequestsPerHour: 2, waitOnHourlyLimit: true },
      },
    });
    const call = async () => ok(1);
    await g.run("data-api", call);
    await g.run("data-api", call);
    expect(c.slept).toEqual([]);
    await g.run("data-api", call); // the third has to wait for the first to be an hour old
    expect(c.slept).toEqual([3_601_000]);
    expect(g.events.filter((e) => e.kind === "hourly-wait")).toHaveLength(1);
    expect(g.report()[0]?.waitedMs).toBe(3_601_000);
  });

  it("does not wait by default: the hourly limit stops a caller unless it chose to wait", async () => {
    const c = fake();
    const g = new RateGovernor({
      now: c.now,
      sleep: c.sleep,
      overrides: { "data-api": { minIntervalMs: 0, maxRequestsPerHour: 1 } },
    });
    await g.run("data-api", async () => ok(1));
    await expect(g.run("data-api", async () => ok(1))).rejects.toBeInstanceOf(HourlyRequestLimit);
    expect(c.slept).toEqual([]);
  });
});
