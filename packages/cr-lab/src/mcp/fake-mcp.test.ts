import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays } from "../data-desk/dates.js";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import { FakeMcp } from "./fake-mcp.js";
import { MCP_DATA_TOOLS, MCP_WITHHELD_TOOLS } from "./types.js";

let backend: FixtureBackend;
let mcp: FakeMcp;
beforeAll(() => {
  backend = new FixtureBackend();
  mcp = new FakeMcp({ backend, today: FIXTURE_AS_OF });
});
afterAll(() => undefined);

const venues = () => backend.world.venues.map((v) => v.id);

describe("the fake MCP server", () => {
  it("offers exactly the four data tools and none of the withheld ones", async () => {
    const names = (await mcp.tools()).map((t) => t.name);
    expect(names.sort()).toEqual([...MCP_DATA_TOOLS].sort());
    for (const w of MCP_WITHHELD_TOOLS) expect(names).not.toContain(w);
  });

  it("lists the models in its catalogs, as JSON text", async () => {
    const ts = JSON.parse((await mcp.call("timeseries_catalog", {})).text);
    expect(ts.models.map((m: { model: string }) => m.model)).toContain("perp-dex-protocols");
    const tab = JSON.parse((await mcp.call("tabular_catalog", {})).text);
    expect(tab.models.map((m: { model: string }) => m.model)).toContain("lending-protocols");
  });

  it("reads a table page and refuses a page size over 200", async () => {
    const r = await mcp.call("tabular_data", { model: "perp-dex-protocols", pageSize: 5 });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).data).toHaveLength(5);
    expect(
      (await mcp.call("tabular_data", { model: "perp-dex-protocols", pageSize: 201 })).isError,
    ).toBe(true);
    expect((await mcp.call("tabular_data", { model: "nope" })).isError).toBe(true);
  });

  it("reads a timeseries over an explicit window, and over a timeframe ending on the snapshot day", async () => {
    const ids = venues().slice(0, 2);
    const a = await mcp.call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: ids,
      start: addDays(FIXTURE_AS_OF, -9),
      end: FIXTURE_AS_OF,
    });
    expect(a.isError).toBe(false);
    const pts = JSON.parse(a.text).data.series[0].points as unknown[];
    expect(pts).toHaveLength(9);
    const b = await mcp.call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: ids,
      timeframe: "10d",
    });
    expect(b.isError).toBe(false);
    expect(JSON.parse(b.text).data.series[0].points).toHaveLength(10);
    const last = JSON.parse(b.text).data.series[0].points.at(-1)[0] as number;
    expect(new Date(last * 1000).toISOString().slice(0, 10)).toBe(FIXTURE_AS_OF);
  });

  it("reads a calendar month by name, and only the bounds when asked", async () => {
    const id = venues()[0] as string;
    const m = await mcp.call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: [id],
      timeframe: "2026-09",
    });
    expect(m.isError).toBe(false);
    expect(JSON.parse(m.text).data.series[0].points).toHaveLength(30);
    const b = await mcp.call("timeseries_data", {
      model: "stablecoins-by-chain",
      granularity: "1d",
      series: [backend.world.tokens.length ? "fixture-chain-a" : "x"],
      timeframe: "90d",
      bounds: true,
    });
    expect(b.isError).toBe(false);
    expect(JSON.parse(b.text).data.series[0].points).toHaveLength(2);
  });

  it("refuses, and never shortens, a call that is too big or malformed", async () => {
    const many = Array.from({ length: 11 }, (_, i) => `entity-${i}`);
    expect(many.length).toBeGreaterThan(10);
    const tooMany = await mcp.call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: many,
      timeframe: "30d",
    });
    expect(tooMany.isError).toBe(true);
    expect(tooMany.text).toMatch(/at most 10 series/);
    const tooBig = await mcp.call("timeseries_data", {
      model: "perp-dex-protocols",
      granularity: "1d",
      series: venues().slice(0, 10),
      start: "2020-01-01",
      end: FIXTURE_AS_OF,
    });
    expect(tooBig.isError).toBe(true);
    for (const bad of [
      { model: "perp-dex-protocols", granularity: "1h", series: ["a"] },
      { model: "perp-dex-protocols", granularity: "1d", series: [] },
      { model: "perp-dex-protocols", granularity: "1d", series: ["a"], timeframe: "forever" },
      { model: "perp-dex-protocols", granularity: "1d", series: ["a"], start: "2026-09-01" },
      {
        model: "perp-dex-protocols",
        granularity: "1d",
        series: ["a"],
        start: "soon",
        end: "later",
      },
    ])
      expect((await mcp.call("timeseries_data", bad)).isError, JSON.stringify(bad)).toBe(true);
    expect((await mcp.call("search_documents", { query: "x" })).isError).toBe(true);
  });

  it("records every call it receives", async () => {
    const before = mcp.calls.length;
    await mcp.call("tabular_catalog", {});
    expect(mcp.calls).toHaveLength(before + 1);
    expect(mcp.calls.at(-1)).toEqual({ name: "tabular_catalog", args: {} });
  });
});
