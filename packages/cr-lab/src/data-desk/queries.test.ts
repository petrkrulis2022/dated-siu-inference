import { describe, expect, it } from "vitest";
import {
  ASSUMED_SHAPES,
  CONFIRMED_SHAPES,
  MAX_POINTS_PER_CALL,
  MAX_SERIES_PER_CALL,
  canonicalQuery,
  catalog,
  governorGroup,
  queryId,
  validateQuery,
} from "./queries.js";

describe("canonical queries", () => {
  it("reads the same whatever order the parameters were written in, and hashes the same", () => {
    const a = { api: "data" as const, path: "/query/tabular/x", params: { b: "2", a: "1" } };
    const b = { api: "data" as const, path: "/query/tabular/x", params: { a: "1", b: "2" } };
    expect(canonicalQuery(a)).toBe("GET data /query/tabular/x?a=1&b=2");
    expect(queryId(a)).toBe(queryId(b));
    expect(queryId(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(queryId(a)).not.toBe(queryId({ ...a, params: { a: "1", b: "3" } }));
  });
});

describe("validateQuery sends nothing it should not", () => {
  const base = { api: "data" as const, path: "/query/timeseries/m/1d", params: {} };
  it("allows only the documented read paths", () => {
    expect(() => validateQuery(base)).not.toThrow();
    for (const path of [
      "/",
      "/admin",
      "/query/other/x",
      "/token-unlocks/v1/assets",
      "http://evil.example/query/tabular/x",
      "//evil.example/query/tabular/x",
      "/query/tabular/../../admin",
      "/query/tabular/x?y=1",
      "/query/tabular/a b",
    ]) {
      expect(() => validateQuery({ ...base, path }), path).toThrow(TypeError);
    }
    expect(() =>
      validateQuery({ api: "token-unlocks", path: "/query/tabular/x", params: {} }),
    ).toThrow(/not an allowed token-unlocks path/);
  });
  it("rejects odd parameter names and empty or multi-line values", () => {
    const bad: Record<string, unknown>[] = [
      { "a b": "1" },
      { "a=": "1" },
      { "": "1" },
      { a: "" },
      { a: "x\ny" },
      { a: 1 },
    ];
    for (const params of bad) {
      expect(
        () => validateQuery({ ...base, params: params as Record<string, string> }),
        JSON.stringify(params),
      ).toThrow(TypeError);
    }
  });
});

describe("catalog builders", () => {
  it("builds each dataset's queries from the documented paths and parameters", () => {
    expect(canonicalQuery(catalog.perpVenues())).toBe(
      "GET data /query/tabular/perp-dex-protocols?pageSize=1000",
    );
    expect(canonicalQuery(catalog.perpVolume(["a", "b"], "2025-10-01", "2026-10-01"))).toBe(
      "GET data /query/timeseries/perp-dex-protocols/1d?end=2026-10-01&selections=volumeUSD&series=a,b&start=2025-10-01",
    );
    expect(canonicalQuery(catalog.lendingFinancials("p1", "2026-07-01", "2026-10-01"))).toBe(
      "GET data /query/timeseries/lending-protocols/1d?end=2026-10-01&selections=fees-usd,revenue-usd,interest-usd,net-interest-income-usd&series=p1&start=2026-07-01",
    );
    expect(canonicalQuery(catalog.tokenUnlockEvents("tok-1", "2026-10-20", "2027-01-18"))).toBe(
      "GET token-unlocks /token-unlocks/v1/assets/tok-1/events?endTime=2027-01-18T00:00:00Z&startTime=2026-10-20T00:00:00Z",
    );
    expect(canonicalQuery(catalog.stablecoinContracts(2))).toBe(
      "GET data /query/tabular/project-tokens?categoryEq=stablecoins&page=2&pageSize=1000",
    );
    expect(canonicalQuery(catalog.stablecoinSupply(["c1"], "2026-07-22", "2026-10-21"))).toBe(
      "GET data /query/timeseries/project-tokens/1d?bounds=true&end=2026-10-21&selections=supplyTotal,priceUSD&series=c1&start=2026-07-22",
    );
    expect(canonicalQuery(catalog.assetBySlug("fixture-token-1"))).toBe(
      "GET data /query/tabular/assets/fixture-token-1?selections=assetID,name,symbol",
    );
    expect(canonicalQuery(catalog.tokenUnlockAssets())).toBe(
      "GET token-unlocks /token-unlocks/v1/assets",
    );
  });

  it("governs data and token-unlock queries in separate groups", () => {
    expect(governorGroup(catalog.perpVenues())).toBe("data-api");
    expect(governorGroup(catalog.tokenUnlockAssets())).toBe("token-unlocks");
  });

  it("refuses an unnamed series, too many series, or too many points: the pull would be rejected or truncated", () => {
    expect(() => catalog.perpVolume([], "2025-10-01", "2026-10-01")).toThrow(
      /must name its series/,
    );
    const many = Array.from({ length: MAX_SERIES_PER_CALL + 1 }, (_, i) => `v${i}`);
    expect(() => catalog.perpVolume(many, "2026-09-01", "2026-10-01")).toThrow(/at most 10 series/);
    const ten = many.slice(0, MAX_SERIES_PER_CALL);
    expect(() => catalog.perpVolume(ten, "2025-10-01", "2026-10-01")).not.toThrow(); // 3,650 points
    expect(() => catalog.perpVolume(ten, "2023-10-01", "2026-10-01")).toThrow(
      new RegExp(`over the ${MAX_POINTS_PER_CALL} per call`),
    );
  });

  it("counts a bounds pull as two points a series, however long the window", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `c${i}`);
    expect(() => catalog.stablecoinSupply(ten, "2020-01-01", "2026-10-21")).not.toThrow();
  });

  it("refuses bad dates, an empty or reversed window, and unsafe identifiers", () => {
    expect(() => catalog.perpVolume(["a"], "2025-13-01", "2026-10-01")).toThrow(TypeError);
    expect(() => catalog.perpVolume(["a"], "2026-10-01", "2026-10-01")).toThrow(RangeError);
    expect(() => catalog.perpVolume(["a"], "2026-10-02", "2026-10-01")).toThrow(RangeError);
    expect(() => catalog.lendingFinancials("a/../b", "2026-07-01", "2026-10-01")).toThrow(
      TypeError,
    );
    expect(() => catalog.assetBySlug("x?y=1")).toThrow(TypeError);
    expect(() => catalog.stablecoinContracts(0)).toThrow(RangeError);
  });

  it("keeps what calibration confirmed against the live API, and what is still only assumed", () => {
    expect(CONFIRMED_SHAPES.length).toBeGreaterThanOrEqual(10);
    expect(ASSUMED_SHAPES.length).toBeGreaterThanOrEqual(3);
    expect(CONFIRMED_SHAPES.join(" ")).toContain("nextDailyAmountNative");
    expect(CONFIRMED_SHAPES.join(" ")).toContain("INCLUSIVE");
  });
});
