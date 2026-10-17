import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D } from "@touchstone/sdk";
import { addDays } from "../data-desk/dates.js";
import { FIXTURE_AS_OF } from "../data-desk/fixtures/world.js";
import { canonicalQuery, catalog, queryId } from "../data-desk/queries.js";
import { Num, parseJsonDecimal } from "../data-desk/json-decimal.js";
import { fixtureDay, type FixtureDay } from "./fixture-day.js";
import { loadDay, parseCanonical, readTimeseries } from "./day-data.js";
import { SnapshotStore } from "../data-desk/snapshots.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let f: FixtureDay;
beforeAll(async () => {
  f = await fixtureDay();
});
afterAll(() => f.cleanup());

describe("parseCanonical", () => {
  it("reads a stored query back into its api, path and parameters", () => {
    const q = catalog.perpVolume(["a", "b"], "2025-10-01", "2026-10-01");
    expect(parseCanonical(canonicalQuery(q))).toEqual({
      api: "data",
      path: q.path,
      params: q.params,
    });
    expect(parseCanonical("GET token-unlocks /token-unlocks/v1/assets")).toEqual({
      api: "token-unlocks",
      path: "/token-unlocks/v1/assets",
      params: {},
    });
    expect(() => parseCanonical("POST data /x")).toThrow(/not a canonical query/);
  });
});

describe("readTimeseries", () => {
  it("returns the fields after time and each series' points, with nulls kept as null", () => {
    const j = parseJsonDecimal(
      '{"error":null,"data":{"point_schema":[{"field":"time"},{"field":"a"},{"field":"b"}],"series":[{"key":"k","points":[[86400,1.50,null],[172800,2,3.25]]}]}}',
    );
    const { fields, series } = readTimeseries(j);
    expect(fields).toEqual(["a", "b"]);
    const pts = series.get("k")!;
    expect(pts.map((p) => p.t)).toEqual([86400, 172800]);
    expect(pts[0]!.v[0]!.toFixed(2)).toBe("1.50");
    expect(pts[0]!.v[1]).toBeNull();
    expect(pts[1]!.v[1]!.toFixed(2)).toBe("3.25");
  });
});

describe("loadDay", () => {
  it("loads every dataset the plan pulled, and reports nothing missing", () => {
    expect(f.plan.failed).toBe(0);
    expect(f.day.missing).toEqual([]);
    expect(f.day.perpVenues).toHaveLength(8);
    expect(f.day.perp.size).toBe(8);
    expect(f.day.lendingProtocols).toHaveLength(6);
    expect(f.day.lending.size).toBe(6);
    expect(f.day.tokenIds.size).toBe(10);
    expect(f.day.schedules.size).toBeGreaterThan(0);
    expect(f.day.stablecoins.chain.size).toBe(7);
    expect(f.day.stablecoins.issuer.size).toBe(6);
  });

  it("keeps each figure exactly as the source wrote it", () => {
    const v = f.world.venues[0]!;
    const d = addDays(FIXTURE_AS_OF, -40);
    const expected = f.world.perpPoint(v, d)!.v.volumeUSD!;
    expect(f.day.perp.get(v.id)!.get(d)!.toFixed(2)).toBe(expected);
  });

  it("keeps a null as null, never as zero", () => {
    const nullDay = addDays(FIXTURE_AS_OF, -100); // the fixtures hold no volume for venue c that day
    expect(f.day.perp.get("fixture-perp-c")!.has(nullDay)).toBe(true);
    expect(f.day.perp.get("fixture-perp-c")!.get(nullDay)).toBeNull();
  });

  it("starts each schedule on the snapshot day and gives the token's span", () => {
    const [slug, sched] = [...f.day.schedules.entries()][0]!;
    expect(sched.days[0]!.day).toBe(FIXTURE_AS_OF);
    expect(sched.days).toHaveLength(91);
    expect(sched.genesis < FIXTURE_AS_OF).toBe(true);
    expect(f.day.tokenIds.get(slug)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the stablecoin endpoints as first and last day, with the dates the plan asked for", () => {
    const b = [...f.day.stablecoins.chain.values()][0]!;
    expect(b.first.day).toBe(addDays(FIXTURE_AS_OF, -90));
    expect(b.last.day).toBe(FIXTURE_AS_OF);
    expect(b.first.usd).toBeInstanceOf(D);
  });

  it("lists a dataset as missing when nothing for it was stored", () => {
    const root = mkdtempSync(join(tmpdir(), "cr-empty-"));
    try {
      const store = new SnapshotStore({
        privateRoot: join(root, "p"),
        manifestDir: join(root, "m"),
        backend: "fixtures",
      });
      const day = loadDay(store, FIXTURE_AS_OF);
      expect(day.missing).toEqual(["perp", "lending", "tokens", "stablecoins"]);
      expect(day.perp.size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lists only the datasets whose steps failed: with no venue list there are no volume batches either", async () => {
    const noVenues = await fixtureDay(FIXTURE_AS_OF, { [queryId(catalog.perpVenues())]: 503 });
    try {
      expect(noVenues.day.missing).not.toContain("lending");
      expect(noVenues.day.perpVenues).toEqual([]); // no venue list, so no volume batches either
      expect(noVenues.day.missing).toContain("perp");
    } finally {
      noVenues.cleanup();
    }
  });

  it("uses Num only inside the parser: every figure it hands out is a decimal", () => {
    for (const m of f.day.perp.values())
      for (const v of m.values()) if (v !== null) expect(v).not.toBeInstanceOf(Num);
  });
});
