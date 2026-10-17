import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays } from "./dates.js";
import { DataDesk } from "./desk.js";
import { FixtureBackend } from "./fixtures/backend.js";
import { FIXTURE_AS_OF } from "./fixtures/world.js";
import { RateGovernor } from "./governor.js";
import { Num, type Json } from "./json-decimal.js";
import { catalog, queryId } from "./queries.js";
import {
  DEFAULT_TOKEN_POOL,
  MIN_SCHEDULE_DAYS_AFTER,
  eligibleToken,
  quarterStart,
  runDailyPlan,
  tokenPool,
} from "./snapshot-plan.js";
import { SnapshotStore } from "./snapshots.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function setup(faults: Record<string, number> = {}) {
  const root = mkdtempSync(join(tmpdir(), "cr-plan-"));
  dirs.push(root);
  const backend = new FixtureBackend({ faults });
  const store = new SnapshotStore({
    privateRoot: join(root, "private"),
    manifestDir: join(root, "manifests"),
    backend: "fixtures",
  });
  const fast = { minIntervalMs: 0, baseBackoffMs: 1, maxBackoffMs: 1, maxRetries: 1 };
  const governor = new RateGovernor({ overrides: { "data-api": fast, "token-unlocks": fast } });
  const lines: string[] = [];
  const desk = new DataDesk({
    backend,
    store,
    governor,
    now: () => new Date("2026-10-20T12:00:00Z"),
    log: (l) => lines.push(l),
  });
  return { backend, store, desk, lines };
}
const W = FIXTURE_AS_OF; // 2026-10-20

describe("the daily plan", () => {
  it("pulls every dataset's candidates, in the number of requests the structure implies, and records each in the manifest", async () => {
    const { desk, backend, store } = setup();
    const r = await runDailyPlan(desk, { window: W });
    expect(r.failed).toBe(0);
    // 8 venues -> 1 batch; 6 lending protocols -> 1 batch; 10 tokens -> 10 schedules + 1 supply batch; 5 chains -> 1 batch; 4 issuers -> 1 batch
    const expected = 1 + 1 + (1 + 1) + (1 + 10 + 1) + (1 + 1) + (1 + 1);
    expect(backend.requests).toHaveLength(expected);
    expect(r.pulled).toBe(expected);
    expect(store.manifest(W)?.entries).toHaveLength(expected);
  });

  it("asks each query for the window the task needs", async () => {
    const { desk, backend } = setup();
    await runDailyPlan(desk, { window: W });
    const q = (path: string) => backend.requests.filter((x) => x.path.includes(path));
    expect(q("/query/timeseries/perp-dex-protocols/1d")[0]?.params).toMatchObject({
      start: "2025-05-01",
      end: "2026-10-01",
    }); // 17 complete months
    expect(q("/query/timeseries/lending-protocols/1d")[0]?.params).toMatchObject({
      start: "2025-10-01",
      end: "2026-10-01",
    }); // four complete quarters
    const sched = q("/unlocks");
    expect(sched).toHaveLength(10);
    expect(sched[0]?.params).toMatchObject({
      interval: "DAILY",
      startTime: `${W}T00:00:00Z`,
      endTime: `${addDays(W, 90)}T00:00:00Z`,
    });
    expect(q("/query/timeseries/asset-supply/1d")[0]?.params).toMatchObject({
      start: addDays(W, -1),
      end: addDays(W, 1),
    });
    for (const m of ["stablecoins-by-chain", "stablecoins-by-issuer"]) {
      expect(q(`/query/timeseries/${m}/1d`)[0]?.params).toMatchObject({
        start: addDays(W, -90),
        end: addDays(W, 1),
        bounds: "true",
      });
    }
  });

  it("never sends more series in one call than the limit allows", async () => {
    const { desk, backend } = setup();
    await runDailyPlan(desk, { window: W });
    for (const x of backend.requests)
      if (x.params.series !== undefined)
        expect(x.params.series.split(",").length).toBeLessThanOrEqual(10);
  });

  it("resumes: a second run requests nothing and reports every step as already stored", async () => {
    const { desk, backend } = setup();
    const first = await runDailyPlan(desk, { window: W });
    const n = backend.requests.length;
    const second = await runDailyPlan(desk, { window: W });
    expect(backend.requests).toHaveLength(n);
    expect(second.pulled).toBe(0);
    expect(second.fromStore).toBe(first.pulled);
  });

  it("carries on past a failed step and picks it up on a later run", async () => {
    const a = setup({ [queryId(catalog.stablecoinIssuers())]: 503 });
    const r = await runDailyPlan(a.desk, { window: W });
    expect(r.failed).toBe(1);
    expect(r.steps.find((s) => !s.ok)).toMatchObject({
      step: "stablecoin issuers",
      error: expect.stringContaining("503"),
    });
    expect(r.steps.filter((s) => s.ok)).toHaveLength(18); // everything else was still pulled: 20 requests less the issuers list and its batch
    expect(a.store.manifest(W)?.entries.length).toBe(r.pulled);
    // Later, with Blockworks answering again, over the same store: only the missing issuers list and its one batch are requested.
    const healthy = new FixtureBackend();
    const fast = { minIntervalMs: 0 };
    const later = new DataDesk({
      backend: healthy,
      store: a.store,
      governor: new RateGovernor({ overrides: { "data-api": fast, "token-unlocks": fast } }),
    });
    const r2 = await runDailyPlan(later, { window: W });
    expect(r2.failed).toBe(0);
    expect(r2.pulled).toBe(2);
    expect(healthy.requests).toHaveLength(2);
  });

  it("a failed batch does not stop the other datasets", async () => {
    const venues = new FixtureBackend().world.venues.map((v) => v.id);
    const fault = { [queryId(catalog.perpVolume(venues, "2025-05-01", "2026-10-01"))]: 500 };
    const { desk } = setup(fault);
    const r = await runDailyPlan(desk, { window: W });
    expect(r.failed).toBe(1);
    expect(r.steps.find((s) => !s.ok)?.step).toBe("perp volume batch 1");
    expect(r.steps.some((s) => s.step.startsWith("lending financials") && s.ok)).toBe(true);
  });

  it("logs step names, sizes and short hashes only, never a venue, a token or a figure", async () => {
    const { desk, lines } = setup();
    const lines2: string[] = [];
    await runDailyPlan(desk, { window: W, log: (l) => lines2.push(l) });
    const all = [...lines, ...lines2].join("\n");
    for (const leak of ["fixture-", "Fixture", "volumeUSD", "FX1", "series"])
      expect(all, leak).not.toContain(leak);
    expect(lines2[0]).toMatch(/^ok {4}perp venues \d+B [0-9a-f]{10}$/);
  });
});

const row = (over: Record<string, string>): Record<string, Json> => ({
  id: "u-1",
  slug: "tok",
  genesisDate: "2024-01-01T00:00:00Z",
  projectedEndDate: "2030-01-01T00:00:00Z",
  ...over,
});

describe("which tokens can be asked for a 90-day schedule", () => {
  it("accepts a token that has begun and whose schedule runs well past the window", () => {
    expect(eligibleToken(row({}), W)).toBe(true);
    expect(
      eligibleToken(
        row({ projectedEndDate: `${addDays(W, MIN_SCHEDULE_DAYS_AFTER)}T00:00:00Z` }),
        W,
      ),
    ).toBe(true);
  });
  it("refuses one whose schedule ends too soon, has not begun, or lacks a slug, an id or a date", () => {
    expect(
      eligibleToken(
        row({ projectedEndDate: `${addDays(W, MIN_SCHEDULE_DAYS_AFTER - 1)}T00:00:00Z` }),
        W,
      ),
    ).toBe(false);
    expect(eligibleToken(row({ genesisDate: `${addDays(W, 1)}T00:00:00Z` }), W)).toBe(false);
    for (const missing of ["slug", "id", "genesisDate", "projectedEndDate"]) {
      const r = row({});
      delete r[missing];
      expect(eligibleToken(r, W), missing).toBe(false);
    }
    expect(eligibleToken({ ...row({}), slug: null }, W)).toBe(false);
    expect(eligibleToken({ ...row({}), id: new Num("5") }, W)).toBe(false);
  });
});

describe("tokenPool", () => {
  const many = Array.from({ length: 60 }, (_, i) => row({ id: `id-${i}`, slug: `token-${i}` }));

  it("takes the first N eligible tokens by a salted hash, not by their order in the list", () => {
    const pool = tokenPool(many, W, 20);
    expect(pool).toHaveLength(20);
    expect(pool.map((p) => p.slug)).not.toEqual(many.slice(0, 20).map((r) => r.slug));
  });
  it("is the same pool whatever order the list arrives in, so it is stable from day to day", () => {
    const a = tokenPool(many, W, 20).map((p) => p.slug);
    const b = tokenPool([...many].reverse(), W, 20).map((p) => p.slug);
    const c = tokenPool(
      [...many].sort(() => 0.5 - Math.random()),
      W,
      20,
    ).map((p) => p.slug);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
  it("leaves out ineligible tokens and returns fewer than N when there are fewer", () => {
    const mixed = [
      ...many.slice(0, 5),
      row({ id: "x", slug: "ends-soon", projectedEndDate: `${addDays(W, 10)}T00:00:00Z` }),
    ];
    const pool = tokenPool(mixed, W, 20);
    expect(pool).toHaveLength(5);
    expect(pool.map((p) => p.slug)).not.toContain("ends-soon");
  });
  it("defaults to a pool of 20, and carries each token's id for the supply call", () => {
    expect(DEFAULT_TOKEN_POOL).toBe(20);
    expect(tokenPool(many, W)[0]).toEqual({
      slug: expect.stringMatching(/^token-/),
      id: expect.stringMatching(/^id-/),
    });
  });
});

describe("quarterStart", () => {
  it("is the first day of the quarter that contains the date", () => {
    expect(quarterStart("2026-10-20")).toBe("2026-10-01");
    expect(quarterStart("2026-12-31")).toBe("2026-10-01");
    expect(quarterStart("2026-03-01")).toBe("2026-01-01");
    expect(quarterStart("2026-05-17")).toBe("2026-04-01");
    expect(quarterStart("2026-09-30")).toBe("2026-07-01");
  });
});
