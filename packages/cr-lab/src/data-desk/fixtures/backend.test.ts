import { describe, expect, it } from "vitest";
import { D } from "@touchstone/sdk";
import { addDays, daysBetween, unixAt } from "../dates.js";
import { Num, parseJsonDecimal, type Json } from "../json-decimal.js";
import { MAX_SERIES_PER_CALL, catalog, queryId } from "../queries.js";
import type { Query } from "../types.js";
import { FixtureBackend } from "./backend.js";
import { FIXTURE_AS_OF, FixtureWorld, decimalText } from "./world.js";

type Obj = { [k: string]: Json };
const dec = new TextDecoder();
async function ask(b: FixtureBackend, q: Query): Promise<{ status: number; json: Obj }> {
  const r = await b.get(q);
  return { status: r.status, json: parseJsonDecimal(dec.decode(r.body)) as Obj };
}
const data = (j: Obj) => j.data as Obj;
const seriesOf = (j: Obj) => (data(j).series as Obj[]) ?? [];
const pointsOf = (s: Obj) => s.points as Json[][];
const d = (n: Json | undefined) => (n instanceof Num ? new D(n.text) : undefined);
const END = addDays(FIXTURE_AS_OF, 1);

describe("the fixture world is synthetic, deterministic and shaped like the docs", () => {
  it("names nothing after a real protocol, venue, token or chain", () => {
    const w = new FixtureWorld();
    const names = [
      ...w.venues.map((v) => v.id),
      ...w.lending.map((p) => p.id),
      ...w.tokens.map((t) => t.slug),
      ...w.contracts.flatMap((c) => [c.chain, c.issuerID]),
    ];
    for (const n of names) expect(n, n).toMatch(/^fixture-/);
  });

  it("is byte-identical for the same seed and different for another", async () => {
    const q = catalog.perpVolume(["fixture-perp-a", "fixture-perp-b"], "2026-09-01", "2026-10-01");
    const a = await new FixtureBackend().get(q);
    const b = await new FixtureBackend().get(q);
    const c = await new FixtureBackend({ world: new FixtureWorld(99) }).get(q);
    expect(dec.decode(a.body)).toBe(dec.decode(b.body));
    expect(dec.decode(a.body)).not.toBe(dec.decode(c.body));
  });

  it("formats big amounts exactly, with no floating point", () => {
    expect(decimalText(123456789012345678901n, 6)).toBe("123456789012345.678901");
    expect(decimalText(5n, 6)).toBe("0.000005");
    expect(decimalText(-1500000n, 6)).toBe("-1.500000");
    expect(decimalText(42n, 0)).toBe("42");
  });
});

describe("tabular responses", () => {
  it("lists the perp venues with the documented envelope: error null, data an array, metadata totals", async () => {
    const { status, json } = await ask(new FixtureBackend(), catalog.perpVenues());
    expect(status).toBe(200);
    expect(json.error).toBeNull();
    expect((json.data as Obj[]).map((r) => r.id)).toHaveLength(8);
    expect(Object.keys((json.data as Obj[])[0] as Obj)).toEqual([
      "id",
      "name",
      "slug",
      "projectID",
    ]);
    expect(json.metadata).toMatchObject({
      totalRows: expect.any(Num),
      totalPages: expect.any(Num),
    });
  });

  it("filters stablecoin contracts by category and pages them with totals for the whole filtered set", async () => {
    const b = new FixtureBackend();
    const all = (await ask(b, catalog.stablecoinContracts(1))).json;
    const rows = all.data as Obj[];
    const total = Number((all.metadata as Obj).totalRows?.toString());
    expect(rows.every((r) => r.category === "stablecoins")).toBe(true);
    expect(rows.length).toBe(total);
    expect(total).toBeGreaterThan(10);
    // The same set in pages of 5 adds up, and a page past the end is empty rather than an error.
    const paged: Query = {
      api: "data",
      path: "/query/tabular/project-tokens",
      params: { categoryEq: "stablecoins", pageSize: "5", page: "1" },
    };
    const first = (await ask(b, paged)).json;
    expect((first.data as Obj[]).length).toBe(5);
    expect((first.metadata as Obj).totalPages?.toString()).toBe(String(Math.ceil(total / 5)));
    const beyond = (await ask(b, { ...paged, params: { ...paged.params, page: "99" } })).json;
    expect(beyond.data).toEqual([]);
    // Without the filter the non-stablecoin rows are there too.
    const unfiltered = (
      await ask(b, {
        api: "data",
        path: "/query/tabular/project-tokens",
        params: { pageSize: "1000" },
      })
    ).json;
    expect((unfiltered.data as Obj[]).some((r) => r.category === "defi")).toBe(true);
  });

  it("rejects an unknown filter and a bad page size, as the real API rejects a bare field", async () => {
    const b = new FixtureBackend();
    expect(
      (
        await ask(b, {
          api: "data",
          path: "/query/tabular/project-tokens",
          params: { chainEq: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ask(b, {
          api: "data",
          path: "/query/tabular/project-tokens",
          params: { pageSize: "5000" },
        })
      ).status,
    ).toBe(400);
  });

  it("resolves a token slug to its assetID, and an unknown slug to no rows", async () => {
    const b = new FixtureBackend();
    const tok = b.world.tokens[0]!;
    expect(((await ask(b, catalog.assetBySlug(tok.slug))).json.data as Obj[])[0]).toEqual({
      assetID: tok.assetID,
      name: tok.name,
      symbol: tok.symbol,
    });
    expect((await ask(b, catalog.assetBySlug("fixture-token-nope"))).json.data).toEqual([]);
  });
});

describe("timeseries responses", () => {
  it("returns the documented envelope: a time entry first in point_schema, then each selection; each point starts with unix seconds", async () => {
    const { json } = await ask(
      new FixtureBackend(),
      catalog.perpVolume(["fixture-perp-a"], "2026-09-01", "2026-09-04"),
    );
    const schema = data(json).point_schema as Obj[];
    expect(schema[0]).toMatchObject({ field: "time", type: "time", time: true });
    expect(schema.map((s) => s.field)).toEqual(["time", "volumeUSD"]);
    const pts = pointsOf(seriesOf(json)[0]!);
    expect(pts.map((p) => (p[0] as Num).text)).toEqual(
      [unixAt("2026-09-01"), unixAt("2026-09-02"), unixAt("2026-09-03")].map(String),
    );
    expect((pts[0]![1] as Num).text).toMatch(/^\d+\.\d{2}$/);
  });

  it("gives one point per day of a half-open window, a month's volume as the exact sum of its days, and no points before a venue launched", async () => {
    const b = new FixtureBackend();
    const venue = b.world.venues[7]!; // launched 200 days before the as-of date
    const june = (
      await ask(b, catalog.perpVolume([venue.id], addDays(venue.launchDay, -30), venue.launchDay))
    ).json;
    expect(pointsOf(seriesOf(june)[0]!)).toEqual([]);
    const win = (await ask(b, catalog.perpVolume([venue.id], "2026-09-01", "2026-10-01"))).json;
    const pts = pointsOf(seriesOf(win)[0]!);
    expect(pts).toHaveLength(30);
    const total = pts.reduce((s, p) => s.plus(d(p[1])!), new D(0));
    expect(total.toFixed(2)).toMatch(/^\d+\.\d{2}$/); // exact: no float drift in a sum of 30 two-decimal figures
  });

  it("reports a figure the source does not hold as null, never as zero", async () => {
    const b = new FixtureBackend();
    const day = addDays(FIXTURE_AS_OF, -100);
    const { json } = await ask(b, catalog.perpVolume(["fixture-perp-c"], day, addDays(day, 1)));
    expect(pointsOf(seriesOf(json)[0]!)[0]![1]).toBeNull();
  });

  it("satisfies the lending identities exactly: fees = interest + the other fees, revenue = net interest income + the other fees, null counting as nothing", async () => {
    const b = new FixtureBackend();
    for (const p of b.world.lending) {
      const { json } = await ask(b, {
        api: "data",
        path: "/query/timeseries/lending-protocols/1d",
        params: { series: p.id, start: "2026-07-01", end: "2026-10-01" },
      });
      const fields = (data(json).point_schema as Obj[]).map((s) => s.field as string);
      const col = (name: string) => fields.indexOf(name);
      for (const pt of pointsOf(seriesOf(json)[0]!)) {
        const v = (name: string) => d(pt[col(name)]) ?? new D(0);
        const extras = v("flash-loan-fees-usd")
          .plus(v("liquidation-fees-usd"))
          .plus(v("royalties-usd"));
        expect(v("fees-usd").toFixed(2)).toBe(v("interest-usd").plus(extras).toFixed(2));
        expect(v("revenue-usd").toFixed(2)).toBe(
          v("net-interest-income-usd").plus(extras).toFixed(2),
        );
        expect(v("revenue-usd").lte(v("fees-usd"))).toBe(true);
      }
    }
  });

  it("answers with only the selected fields, in the order asked", async () => {
    const { json } = await ask(
      new FixtureBackend(),
      catalog.lendingFinancials("fixture-lend-1", "2026-07-01", "2026-07-03"),
    );
    expect((data(json).point_schema as Obj[]).map((s) => s.field)).toEqual([
      "time",
      "fees-usd",
      "revenue-usd",
      "interest-usd",
      "net-interest-income-usd",
    ]);
  });

  it("returns an unknown series as an empty series rather than an error, as the docs say", async () => {
    const { status, json } = await ask(
      new FixtureBackend(),
      catalog.perpVolume(["fixture-perp-zzz"], "2026-09-01", "2026-09-03"),
    );
    expect(status).toBe(200);
    expect(pointsOf(seriesOf(json)[0]!)).toEqual([]);
  });

  it("returns only the first and last point with bounds, including both prices for a depegged stablecoin", async () => {
    const b = new FixtureBackend();
    const depegged = b.world.contracts[2]!;
    const { json } = await ask(
      b,
      catalog.stablecoinSupply([depegged.id], addDays(FIXTURE_AS_OF, -90), END),
    );
    const pts = pointsOf(seriesOf(json)[0]!);
    expect(pts).toHaveLength(2);
    expect(daysBetween(addDays(FIXTURE_AS_OF, -90), FIXTURE_AS_OF)).toBe(90);
    const price = (p: Json[]) => d(p[2])!; // columns: time, supplyTotal, priceUSD
    expect(price(pts[0]!).gt("0.99")).toBe(true); // at the start of the window it held its peg
    expect(price(pts[1]!).lt("0.7")).toBe(true); // by the end it had not: valuing both ends at the end price (D90) is what keeps this from reading as a supply move
  });

  it("enforces the documented limits, so the catalog cannot drift past them: 10 series, 9,000 points, a window", async () => {
    const b = new FixtureBackend();
    const base = { api: "data" as const, path: "/query/timeseries/perp-dex-protocols/1d" };
    const many = Array.from({ length: MAX_SERIES_PER_CALL + 1 }, (_, i) => `s${i}`).join(",");
    expect(
      (await ask(b, { ...base, params: { series: many, start: "2026-09-01", end: "2026-09-02" } }))
        .status,
    ).toBe(400);
    expect(
      (
        await ask(b, {
          ...base,
          params: { series: "fixture-perp-a", start: "2000-01-01", end: "2026-10-01" },
        })
      ).status,
    ).toBe(400); // 9,770 days, over 9,000 points
    expect(
      (await ask(b, { ...base, params: { series: "fixture-perp-a", start: "2026-09-01" } })).status,
    ).toBe(400);
    expect(
      (
        await ask(b, {
          ...base,
          params: { series: "fixture-perp-a", start: "2026-09-02", end: "2026-09-01" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ask(b, {
          ...base,
          params: {
            series: "fixture-perp-a",
            selections: "nonsense",
            start: "2026-09-01",
            end: "2026-09-02",
          },
        })
      ).status,
    ).toBe(400);
    const failure = (
      await ask(b, { ...base, params: { series: many, start: "2026-09-01", end: "2026-09-02" } })
    ).json;
    expect(failure.data).toBeNull();
    expect(typeof failure.error).toBe("string");
  });
});

describe("token unlocks", () => {
  const b = new FixtureBackend();
  const tok = b.world.tokens[0]!;

  it("lists the assets, and finds events by slug or by id", async () => {
    expect(
      ((await ask(b, catalog.tokenUnlockAssets())).json.data as Obj[]).map((a) => a.slug),
    ).toHaveLength(10);
    const win = ["2026-01-01", "2028-01-01"] as const;
    const bySlug = (await ask(b, catalog.tokenUnlockEvents(tok.slug, ...win))).json;
    const byId = (await ask(b, catalog.tokenUnlockEvents(tok.assetID, ...win))).json;
    expect(bySlug).toEqual(byId);
    expect((await ask(b, catalog.tokenUnlockEvents("fixture-token-nope", ...win))).status).toBe(
      404,
    );
  });

  it("gives each event one of cliff or dailyLinearRateChange, never both, each with the documented amounts", async () => {
    const { json } = await ask(b, catalog.tokenUnlockEvents(tok.slug, "2025-01-01", "2028-01-01"));
    const events = data(json).unlockEvents as Obj[];
    expect(events.length).toBeGreaterThan(2);
    for (const e of events) {
      expect((e.cliff === null) !== (e.dailyLinearRateChange === null)).toBe(true);
      const t = (e.cliff ?? e.dailyLinearRateChange) as Obj;
      expect(Object.keys(t)).toEqual([
        "amountNative",
        "amountUSD",
        "percentOfTotalAllocation",
        "allocations",
      ]);
      expect(typeof (e.timestamp as string)).toBe("string");
    }
    const dates = events.map((e) => e.timestamp as string);
    expect([...dates].sort()).toEqual(dates);
  });

  it("returns data: null, with status 200, for a window with no events", async () => {
    const r = await ask(b, catalog.tokenUnlockEvents(tok.slug, "2010-01-01", "2010-02-01"));
    expect(r.status).toBe(200);
    expect(r.json.data).toBeNull();
    expect(r.json.error).toBeNull();
  });

  it("keeps the schedule, the supply series and the events consistent: supply rises by exactly what unlocks", async () => {
    const start = addDays(FIXTURE_AS_OF, -30);
    const end = addDays(FIXTURE_AS_OF, 91);
    const sched = (await ask(b, catalog.tokenUnlockSchedule(tok.slug, "DAILY", start, end))).json;
    const snaps = data(sched).totalSnapshots as Obj[];
    expect(snaps).toHaveLength(121);
    const unlocked = snaps.reduce((s, x) => s.plus(d(x.unlockedInPeriodNative)!), new D(0));
    const sup = (await ask(b, catalog.assetSupply(tok.assetID, addDays(start, -1), end))).json;
    const pts = pointsOf(seriesOf(sup)[0]!);
    const before = d(pts[0]![1])!;
    const after = d(pts[pts.length - 1]![1])!;
    expect(after.minus(before).toFixed(6)).toBe(unlocked.toFixed(6));
    let prev = new D(-1);
    for (const p of pts) {
      expect(d(p[1])!.gte(prev)).toBe(true); // circulating supply never falls
      prev = d(p[1])!;
    }
  });

  it("aggregates the same unlocks weekly and monthly without losing or inventing any", async () => {
    const start = "2026-10-20";
    const end = "2027-02-01";
    const total = async (interval: "DAILY" | "WEEKLY" | "MONTHLY") =>
      (
        data((await ask(b, catalog.tokenUnlockSchedule(tok.slug, interval, start, end))).json)
          .totalSnapshots as Obj[]
      )
        .reduce((s, x) => s.plus(d(x.unlockedInPeriodNative)!), new D(0))
        .toFixed(6);
    const daily = await total("DAILY");
    expect(await total("WEEKLY")).toBe(daily);
    expect(await total("MONTHLY")).toBe(daily);
  });

  it("requires an interval on the schedule", async () => {
    const q: Query = {
      api: "token-unlocks",
      path: `/token-unlocks/v1/assets/${tok.slug}/unlocks`,
      params: { startTime: "2026-10-20T00:00:00Z", endTime: "2026-11-20T00:00:00Z" },
    };
    expect((await ask(b, q)).status).toBe(400);
  });
});

describe("the fixture backend as a test double", () => {
  it("records every query it receives, and refuses a path the catalog never builds", async () => {
    const b = new FixtureBackend();
    await b.get(catalog.perpVenues());
    expect(b.requests).toHaveLength(1);
    await expect(b.get({ api: "data", path: "/admin", params: {} })).rejects.toThrow(TypeError);
    expect(
      (await ask(b, { api: "data", path: "/query/tabular/nonexistent", params: {} })).status,
    ).toBe(404);
  });

  it("answers a query with a chosen status when told to, with the error envelope", async () => {
    const q = catalog.perpVenues();
    const b = new FixtureBackend({ faults: { [queryId(q)]: 503 } });
    const r = await ask(b, q);
    expect(r.status).toBe(503);
    expect(r.json.data).toBeNull();
    expect(typeof r.json.error).toBe("string");
  });

  it("reports the versions of the two APIs it stands in for", async () => {
    expect(await new FixtureBackend().specVersions()).toEqual({
      "data-api": "fixtures-0.1.0",
      "token-unlocks": "fixtures-1.0.0",
    });
  });
});
