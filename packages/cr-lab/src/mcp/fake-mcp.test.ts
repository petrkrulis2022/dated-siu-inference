import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../data-desk/dates.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import { FakeMcp, MCP_MAX_NAMED_SERIES, MCP_MAX_POINTS, MCP_MAX_SERIES } from "./fake-mcp.js";
import { MCP_DATA_TOOLS, MCP_WITHHELD_TOOLS } from "./types.js";

let backend: FixtureBackend;
let mcp: FakeMcp;
beforeAll(() => {
  backend = new FixtureBackend();
  mcp = new FakeMcp({ backend, today: FIXTURE_AS_OF });
});
afterAll(() => undefined);

const venues = () => backend.world.venues.map((v) => v.id);
const read = (args: Record<string, unknown>) =>
  mcp.call("timeseries_data", { model: "perp-dex-protocols", ...args });
const parse = (text: string) =>
  JSON.parse(text) as {
    model: string;
    granularity: string;
    point_schema: { field: string }[];
    series: { key: string; points: unknown[][] }[];
    totalPoints: number;
  };
const dayOf = (t: unknown) => new Date((t as number) * 1000).toISOString().slice(0, 10);

describe("the fake MCP server: tools and catalogs", () => {
  it("offers exactly the four data tools and none of the withheld ones", async () => {
    const names = (await mcp.tools()).map((t) => t.name);
    expect(names.sort()).toEqual([...MCP_DATA_TOOLS].sort());
    for (const w of MCP_WITHHELD_TOOLS) expect(names).not.toContain(w);
  });

  it("lists models as the live catalog does: slug, access, metric count, intervals and allowAllSeries", async () => {
    const ts = JSON.parse((await mcp.call("timeseries_catalog", {})).text).models as Record<
      string,
      unknown
    >[];
    const perp = ts.find((m) => m.slug === "perp-dex-protocols");
    expect(perp).toMatchObject({
      metricCount: 96,
      intervals: ["1d"],
      allowAllSeries: true,
      access: { permissionSlug: "projects_protocols_unified" },
    });
    expect(ts.find((m) => m.slug === "asset-supply")).toMatchObject({
      allowAllSeries: false,
      intervals: ["1d", "1w"],
    });
    const tab = JSON.parse((await mcp.call("tabular_catalog", {})).text).models as {
      slug: string;
    }[];
    expect(tab.map((m) => m.slug)).toContain("lending-protocols");
  });

  it("describes one model in full, and narrows a list by search", async () => {
    const one = JSON.parse(
      (await mcp.call("timeseries_catalog", { model: "perp-dex-protocols" })).text,
    );
    expect(one.metrics).toHaveLength(96);
    expect(one.metrics[0].field).toBe("volumeUSD");
    const found = JSON.parse((await mcp.call("timeseries_catalog", { search: "stablecoin" })).text)
      .models as { slug: string }[];
    expect(found.map((m) => m.slug).sort()).toEqual([
      "stablecoins-by-chain",
      "stablecoins-by-issuer",
    ]);
    expect((await mcp.call("timeseries_catalog", { model: "nope" })).isError).toBe(true);
  });
});

describe("the fake MCP server: reading series", () => {
  it("leaving out `series` reads every series, for a model that allows it, and refuses for one that does not", async () => {
    const r = await read({ timeframe: "10d" });
    expect(r.isError).toBe(false);
    expect(
      parse(r.text)
        .series.map((s) => s.key)
        .sort(),
    ).toEqual(venues().sort());
    const no = await mcp.call("timeseries_data", { model: "asset-supply", timeframe: "10d" });
    expect(no.isError).toBe(true);
    expect(no.text).toMatch(/allowAllSeries is false/);
  });

  it("advertises 20 series a call but, as the live server does, refuses to NAME more than 10 (first live session, 2026-10-20)", async () => {
    const named = (n: number) => Array.from({ length: n }, (_, i) => `entity-${i}`);
    expect((await read({ series: named(MCP_MAX_NAMED_SERIES), timeframe: "5d" })).isError).toBe(
      false,
    );
    const tooMany = await read({ series: named(MCP_MAX_SERIES), timeframe: "5d" });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toBe("Error: too many series requested: 20 exceeds the maximum of 10");
    const schema = (await mcp.tools()).find((t) => t.name === "timeseries_data")?.inputSchema as {
      properties: { series: { description?: string } };
    };
    expect(schema.properties.series.description).toMatch(/at most 20/);
  });

  it("refuses a read that leaves out `series` when it would return more than 20, naming the limit, as the live server does (201 series on the first live session)", async () => {
    const rows = Array.from({ length: 21 }, (_, i) => ({ id: `v${i}` }));
    const stub = {
      name: "fixtures" as const,
      specVersions: async () => ({}),
      get: async () => ({
        status: 200,
        body: new TextEncoder().encode(JSON.stringify({ data: rows })),
      }),
    } as never;
    const r = await new FakeMcp({ backend: stub, today: FIXTURE_AS_OF }).call("timeseries_data", {
      model: "perp-dex-protocols",
      timeframe: "5d",
    });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      "Error: this read returned 21 series, over the 20-series limit for one call: name the specific series you need in the series argument",
    );
  });

  it("refuses a call over 5,000 points across all series, and never shortens it", async () => {
    const days = Math.floor(MCP_MAX_POINTS / venues().length) + 1;
    const big = await read({ timeframe: `${days}d` });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/over the 5000-point limit/);
    const justUnder = await read({ timeframe: `${Math.floor(MCP_MAX_POINTS / venues().length)}d` });
    expect(justUnder.isError).toBe(false);
    // bounds counts two points a series, so it fits whatever the window
    expect((await read({ timeframe: "ytd", bounds: true })).isError).toBe(false);
    expect(
      parse((await read({ timeframe: "ytd", bounds: true })).text).series[0]?.points,
    ).toHaveLength(2);
  });

  it("a window is a timeframe or a start and end, never both, and is the last 90 days if neither", async () => {
    const both = await read({ timeframe: "30d", start: "2026-09-01", end: "2026-09-10" });
    expect(both.isError).toBe(true);
    expect(both.text).toMatch(/never both/);
    expect((await read({ start: "2026-09-01" })).isError).toBe(true);
    const dflt = parse((await read({ series: [venues()[0]] })).text);
    expect(dflt.series[0]?.points).toHaveLength(90);
    const range = parse(
      (await read({ series: [venues()[0]], start: addDays(FIXTURE_AS_OF, -9), end: FIXTURE_AS_OF }))
        .text,
    );
    expect(range.series[0]?.points).toHaveLength(9); // end is exclusive
  });

  it("understands the documented timeframes: days, weeks, to-date, and calendar periods", async () => {
    const len = async (timeframe: string) =>
      parse((await read({ series: [venues()[0]], timeframe })).text).series[0]?.points.length;
    expect(await len("10d")).toBe(10);
    expect(await len("2w")).toBe(14);
    expect(await len("dtd")).toBe(1);
    expect(await len("2026-09")).toBe(30);
    expect(await len("2026-09-15")).toBe(1);
    expect(await len("mtd")).toBe(Number(FIXTURE_AS_OF.slice(8, 10)));
    const last = parse(
      (await read({ series: [venues()[0]], timeframe: "5d" })).text,
    ).series[0]?.points.at(-1)?.[0];
    expect(dayOf(last)).toBe(FIXTURE_AS_OF);
    expect((await read({ series: ["a"], timeframe: "forever" })).isError).toBe(true);
  });

  it("returns every metric when none are named, padded to the live count, and only those asked for otherwise", async () => {
    const all = parse((await read({ series: [venues()[0]], timeframe: "3d" })).text);
    expect(all.point_schema).toHaveLength(1 + 96); // the time and 96 metrics
    expect(all.series[0]?.points[0]).toHaveLength(1 + 96);
    const one = parse(
      (await read({ series: [venues()[0]], timeframe: "3d", selections: ["volumeUSD"] })).text,
    );
    expect(one.point_schema.map((s) => s.field)).toEqual(["time", "volumeUSD"]);
    expect(one.series[0]?.points[0]).toHaveLength(2);
    const bad = await read({ series: [venues()[0]], timeframe: "3d", selections: ["nope"] });
    expect(bad.isError).toBe(true);
    // the padding makes an unselective read far bigger: that is the point
    expect((await read({ series: [venues()[0]], timeframe: "30d" })).text.length).toBeGreaterThan(
      10 *
        (await read({ series: [venues()[0]], timeframe: "30d", selections: ["volumeUSD"] })).text
          .length,
    );
  });

  it("reads a calendar month by name, only the bounds when asked, and refuses what is malformed", async () => {
    const id = venues()[0] as string;
    expect(
      parse((await read({ series: [id], timeframe: "2026-09", selections: ["volumeUSD"] })).text)
        .series[0]?.points,
    ).toHaveLength(30);
    const b = await mcp.call("timeseries_data", {
      model: "stablecoins-by-chain",
      series: ["fixture-chain-a"],
      timeframe: "90d",
      bounds: true,
      selections: ["circulatingSupplyUSD"],
    });
    expect(b.isError).toBe(false);
    expect(parse(b.text).series[0]?.points).toHaveLength(2);
    for (const bad of [
      { granularity: "1h", series: ["a"] },
      { series: [] },
      { series: ["a"], start: "soon", end: "later" },
      { model: "nope" },
    ])
      expect(
        (await mcp.call("timeseries_data", { model: "perp-dex-protocols", ...bad })).isError,
        JSON.stringify(bad),
      ).toBe(true);
    expect((await mcp.call("search_documents", { query: "x" })).isError).toBe(true);
  });
});

describe("the fake MCP server: tables", () => {
  it("reads 25 rows by default and at most 200, and says it does not do filters", async () => {
    const r = await mcp.call("tabular_data", { model: "perp-dex-protocols" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).rows).toHaveLength(venues().length);
    expect(
      (await mcp.call("tabular_data", { model: "perp-dex-protocols", pageSize: 5 })).isError,
    ).toBe(false);
    expect(
      (await mcp.call("tabular_data", { model: "perp-dex-protocols", pageSize: 201 })).isError,
    ).toBe(true);
    expect((await mcp.call("tabular_data", { model: "nope" })).isError).toBe(true);
    const f = await mcp.call("tabular_data", {
      model: "perp-dex-protocols",
      filters: [{ field: "id", operator: "Equals", values: ["x"] }],
    });
    expect(f.isError).toBe(true);
  });

  it("records every call it receives", async () => {
    const before = mcp.calls.length;
    await mcp.call("tabular_catalog", {});
    expect(mcp.calls).toHaveLength(before + 1);
    expect(mcp.calls.at(-1)).toEqual({ name: "tabular_catalog", args: {} });
  });
});
