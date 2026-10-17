import { describe, expect, it } from "vitest";
import { D } from "@touchstone/sdk";
import { addDays, daysBetween, unixAt } from "../dates.js";
import { Num, parseJsonDecimal, type Json } from "../json-decimal.js";
import { MAX_SERIES_PER_CALL, catalog, queryId } from "../queries.js";
import type { Query } from "../types.js";
import { FixtureBackend } from "./backend.js";
import { CHAINS, FIXTURE_AS_OF, FixtureWorld, ISSUERS, decimalText } from "./world.js";

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

  it("lists the stablecoin chains and issuers, and pages them with the totals the docs state", async () => {
    const b = new FixtureBackend();
    const chains = (await ask(b, catalog.stablecoinChains())).json;
    expect((chains.data as Obj[]).map((r) => r.id)).toEqual(CHAINS);
    expect(Object.keys((chains.data as Obj[])[0] as Obj)).toEqual([
      "id",
      "name",
      "slug",
      "networkID",
    ]);
    const issuers = (await ask(b, catalog.stablecoinIssuers())).json;
    expect((issuers.data as Obj[]).map((r) => r.id)).toEqual(ISSUERS);
    expect(Object.keys((issuers.data as Obj[])[0] as Obj)).toEqual([
      "id",
      "name",
      "slug",
      "projectID",
    ]);
    // pages of 2: four pages for seven chains, and a page past the end is empty rather than an error
    const paged: Query = {
      api: "data",
      path: "/query/tabular/stablecoin-chains",
      params: { pageSize: "2", page: "1" },
    };
    const first = (await ask(b, paged)).json;
    expect((first.data as Obj[]).length).toBe(2);
    expect((first.metadata as Obj).totalRows?.toString()).toBe(String(CHAINS.length));
    expect((first.metadata as Obj).totalPages?.toString()).toBe(
      String(Math.ceil(CHAINS.length / 2)),
    );
    expect((await ask(b, { ...paged, params: { ...paged.params, page: "99" } })).json.data).toEqual(
      [],
    );
  });

  it("rejects a filter it does not implement and a bad page size, as the real API rejects a bare field", async () => {
    const b = new FixtureBackend();
    expect(
      (
        await ask(b, {
          api: "data",
          path: "/query/tabular/stablecoin-chains",
          params: { chainEq: "x" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await ask(b, {
          api: "data",
          path: "/query/tabular/stablecoin-chains",
          params: { pageSize: "5000" },
        })
      ).status,
    ).toBe(400);
  });

  it("resolves a token slug to its assetID as one object, with the column that matched, and an unknown slug to a 404", async () => {
    const b = new FixtureBackend();
    const tok = b.world.tokens[0]!;
    const r = (await ask(b, catalog.assetBySlug(tok.slug))).json;
    expect(r.data).toEqual({ assetID: tok.assetID, name: tok.name, symbol: tok.symbol });
    expect(r.metadata).toEqual({ matchedField: "slug" });
    expect((await ask(b, catalog.assetBySlug("fixture-token-nope"))).status).toBe(404);
  });

  it("leaves slug and projectID null for some perp venues, as the real model does: the id is the key", async () => {
    const rows = ((await ask(new FixtureBackend(), catalog.perpVenues())).json.data as Obj[]).map(
      (r) => r,
    );
    expect(rows.some((r) => r.slug === null && r.projectID === null)).toBe(true);
    expect(rows.every((r) => typeof r.id === "string")).toBe(true);
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
      catalog.lendingFinancials(["fixture-lend-1"], "2026-07-01", "2026-07-03"),
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

  it("returns only the first and last day with bounds, and the chains and issuers add up to the same total", async () => {
    const b = new FixtureBackend();
    const start = addDays(FIXTURE_AS_OF, -90);
    const chains = (await ask(b, catalog.stablecoinChains())).json.data as Obj[];
    const issuers = (await ask(b, catalog.stablecoinIssuers())).json.data as Obj[];
    const byChain = (
      await ask(
        b,
        catalog.stablecoinsByChain(
          chains.map((r) => String(r.id)),
          start,
          END,
        ),
      )
    ).json;
    const byIssuer = (
      await ask(
        b,
        catalog.stablecoinsByIssuer(
          issuers.map((r) => String(r.id)),
          start,
          END,
        ),
      )
    ).json;
    expect((data(byChain).point_schema as Obj[]).map((x) => x.field)).toEqual([
      "time",
      "circulatingSupplyUSD",
    ]);
    const ends = (j: Obj, which: 0 | 1) =>
      seriesOf(j).reduce((sum, ser) => {
        const pts = pointsOf(ser);
        expect(pts).toHaveLength(2); // bounds: the first and last day only
        return sum.plus(d(pts[which]![1])!);
      }, new D(0));
    // Summed across issuers, a chain's supply; summed across chains, an issuer's. Both partitions of the same contracts, so the grand totals must agree exactly, on both days.
    expect(ends(byChain, 0).toFixed(6)).toBe(ends(byIssuer, 0).toFixed(6));
    expect(ends(byChain, 1).toFixed(6)).toBe(ends(byIssuer, 1).toFixed(6));
    const first = pointsOf(seriesOf(byChain)[0]!)[0]![0] as Num;
    expect(first.text).toBe(String(unixAt(start)));
    expect(daysBetween(start, FIXTURE_AS_OF)).toBe(90);
  });

  it("values supply at each day's price, so a contract that falls below one dollar shows up as a fall in its chain's USD supply", async () => {
    const b = new FixtureBackend();
    const c = b.world.contracts[2]!; // the contract that has fallen below one dollar
    const before = addDays(FIXTURE_AS_OF, -20);
    const same = (day: string) => b.world.contractSupply(c, day);
    expect(b.world.contractPriceMicro(c, before)).toBeGreaterThan(990_000n);
    expect(b.world.contractPriceMicro(c, FIXTURE_AS_OF)).toBe(620_000n);
    const usd = (day: string) => (same(day) * b.world.contractPriceMicro(c, day)) / 1_000_000n;
    expect(usd(before)).toBeGreaterThan((same(before) * 990_000n) / 1_000_000n); // at par: worth about its token count in dollars
    expect(usd(FIXTURE_AS_OF)).toBeLessThan((same(FIXTURE_AS_OF) * 700_000n) / 1_000_000n); // below par: worth well under 70 cents on the dollar
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
  const withStream = b.world.tokens.find((t) => t.streams.length > 0)!;

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

  it("answers with the asset and an unlockEvents list; each event has one of cliff or dailyLinearRateChange, in the live API's field names", async () => {
    const { json } = await ask(
      b,
      catalog.tokenUnlockEvents(withStream.slug, "2020-01-01", "2030-01-01"),
    );
    expect(Object.keys(data(json))).toEqual(["asset", "unlockEvents"]);
    expect(Object.keys(data(json).asset as Obj)).toEqual(["id", "name", "slug", "symbol"]);
    const events = data(json).unlockEvents as Obj[];
    expect(events.length).toBeGreaterThan(2);
    let sawRate = false;
    for (const e of events) {
      expect((e.cliff === null) !== (e.dailyLinearRateChange === null)).toBe(true);
      if (e.cliff !== null)
        expect(Object.keys(e.cliff as Obj)).toEqual([
          "amountNative",
          "amountUSD",
          "percentOfTotalAllocation",
          "allocations",
        ]);
      else {
        sawRate = true;
        expect(Object.keys(e.dailyLinearRateChange as Obj)).toEqual([
          "dailyAmountNative",
          "dailyAmountUSD",
          "nextDailyAmountNative",
          "nextDailyAmountUSD",
          "percentOfTotalAllocation",
          "nextPercentOfTotalAllocation",
          "percentChangeOfRate",
          "allocations",
        ]);
      }
      expect(typeof (e.timestamp as string)).toBe("string");
    }
    expect(sawRate).toBe(true);
    const dates = events.map((e) => e.timestamp as string);
    expect([...dates].sort()).toEqual(dates);
  });

  it("returns a data object with an EMPTY unlockEvents list, with status 200, for a window with no events", async () => {
    const r = await ask(b, catalog.tokenUnlockEvents(tok.slug, "2010-01-01", "2010-02-01"));
    expect(r.status).toBe(200);
    expect(r.json.error).toBeNull();
    expect(data(r.json).unlockEvents).toEqual([]);
    expect(Object.keys(data(r.json).asset as Obj)).toEqual(["id", "name", "slug", "symbol"]);
  });

  it("includes the end day of a schedule: 31 calendar days give 31 daily snapshots", async () => {
    const start = "2026-10-20";
    const sched = (
      await ask(b, catalog.tokenUnlockSchedule(withStream.slug, "DAILY", start, addDays(start, 30)))
    ).json;
    expect(Object.keys(data(sched))).toEqual([
      "asset",
      "genesisDate",
      "projectedEndDate",
      "startDate",
      "endDate",
      "interval",
      "totalSnapshots",
      "allocations",
    ]);
    expect(data(sched).totalSnapshots as Obj[]).toHaveLength(31);
  });

  it("refuses a schedule that starts before genesis or after the projected end, in the live API's words", async () => {
    const { genesis, projectedEnd } = b.world.span(tok);
    const late = await ask(
      b,
      catalog.tokenUnlockSchedule(
        tok.slug,
        "DAILY",
        addDays(projectedEnd, 1),
        addDays(projectedEnd, 10),
      ),
    );
    expect(late.status).toBe(400);
    expect(late.json.error).toMatch(
      /start time cannot be before genesis date \[.*\] or after the projected end date \[.*\]/,
    );
    expect(
      (
        await ask(
          b,
          catalog.tokenUnlockSchedule(tok.slug, "DAILY", addDays(genesis, -5), addDays(genesis, 5)),
        )
      ).status,
    ).toBe(400);
  });

  it("reads the daily rate from nextDailyAmountNative: the rate in effect on each day, plus that day's cliffs, reproduces the schedule on every day", async () => {
    const { genesis: start, projectedEnd: end } = b.world.span(withStream); // the whole span the schedule endpoint allows
    const events = (
      data(
        (await ask(b, catalog.tokenUnlockEvents(withStream.slug, "2000-01-01", addDays(end, 1))))
          .json,
      ).unlockEvents as Obj[]
    ).map((e) => ({
      day: (e.timestamp as string).slice(0, 10),
      cliff: e.cliff as Obj | null,
      rate: e.dailyLinearRateChange as Obj | null,
    }));
    const snaps = data(
      (await ask(b, catalog.tokenUnlockSchedule(withStream.slug, "DAILY", start, end))).json,
    ).totalSnapshots as Obj[];
    let rateReading = 0;
    let wrongReading = 0;
    for (const snap of snaps) {
      const day = (snap.timestamp as string).slice(0, 10);
      let cliff = new D(0);
      let next = new D(0);
      let prior = new D(0);
      for (const e of events) {
        if (e.day > day) continue;
        if (e.cliff !== null && e.day === day)
          cliff = cliff.plus(d((e.cliff as Obj).amountNative)!);
        if (e.rate !== null) {
          next = d(e.rate.nextDailyAmountNative)!;
          prior = d(e.rate.dailyAmountNative)!;
        }
      }
      const actual = d(snap.unlockedInPeriodNative)!;
      if (cliff.plus(next).eq(actual)) rateReading++;
      if (cliff.plus(prior).eq(actual)) wrongReading++;
    }
    expect(rateReading).toBe(snaps.length);
    expect(wrongReading).toBeLessThan(snaps.length); // dailyAmountNative, the rate BEFORE the change, is not what the schedule uses
  });

  it("keeps the schedule and the supply series consistent: supply rises by exactly what unlocks", async () => {
    const start = addDays(FIXTURE_AS_OF, -30);
    const end = addDays(FIXTURE_AS_OF, 90);
    const sched = (await ask(b, catalog.tokenUnlockSchedule(tok.slug, "DAILY", start, end))).json;
    const snaps = data(sched).totalSnapshots as Obj[];
    expect(snaps).toHaveLength(121);
    const unlocked = snaps.reduce((s, x) => s.plus(d(x.unlockedInPeriodNative)!), new D(0));
    const sup = (
      await ask(b, catalog.assetSupply([tok.assetID], addDays(start, -1), addDays(end, 1)))
    ).json;
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
    const end = "2027-01-31";
    const total = async (interval: "DAILY" | "WEEKLY" | "MONTHLY") =>
      (
        data(
          (await ask(b, catalog.tokenUnlockSchedule(withStream.slug, interval, start, end))).json,
        ).totalSnapshots as Obj[]
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
      path: `/token-unlocks/v1/assets/${withStream.slug}/unlocks`,
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
