/**
 * What the trial asks Blockworks, one builder per dataset (§16.12). Built from the public documentation and **confirmed against the live API on day 1**; the shapes this
 * assumes beyond what the docs state are listed in `ASSUMED_SHAPES` so calibration has a checklist.
 *
 * Every query is explicit and reproducible: a calendar window (`start` inclusive, `end` exclusive) rather than a relative `timeframe`, parameters sorted, one canonical text.
 * `queryId` is the sha256 of that text, which is what the committed manifest records instead of the query itself.
 */
import { createHash } from "node:crypto";
import { assertDate, daysBetween } from "./dates.js";
import type { Api, Query } from "./types.js";

/** The docs say 10 series per call in the OpenAPI spec and 20 elsewhere: use the smaller. */
export const MAX_SERIES_PER_CALL = 10;
/** The documented ceiling on points in one timeseries response. */
export const MAX_POINTS_PER_CALL = 9_000;
export const MAX_PAGE_SIZE = 1_000;

const PATH_PREFIX: Record<Api, readonly string[]> = {
  data: ["/query/timeseries/", "/query/tabular/"],
  "token-unlocks": ["/token-unlocks/v1/"],
};

/** Throws unless `q` is a read of an allowed path, with sane parameters. The live backend sends nothing that has not passed this. */
export function validateQuery(q: Query): Query {
  if (!(q.api in PATH_PREFIX)) throw new TypeError(`unknown api ${String(q.api)}`);
  if (!PATH_PREFIX[q.api].some((p) => q.path.startsWith(p)))
    throw new TypeError(`path ${q.path} is not an allowed ${q.api} path`);
  if (
    q.path.includes("..") ||
    q.path.includes("//") ||
    /[\s?#\\]/.test(q.path) ||
    !/^\/[A-Za-z0-9._~/%-]+$/.test(q.path)
  )
    throw new TypeError(`path ${q.path} is not a plain path`);
  for (const [k, v] of Object.entries(q.params)) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(k))
      throw new TypeError(`parameter name ${JSON.stringify(k)} is not a plain name`);
    if (typeof v !== "string" || v === "" || /[\r\n]/.test(v))
      throw new TypeError(`parameter ${k} must be a non-empty single-line string`);
  }
  return q;
}

/** The query as one line of text, parameters sorted: the same query always reads the same. */
export function canonicalQuery(q: Query): string {
  validateQuery(q);
  const params = Object.keys(q.params)
    .sort()
    .map((k) => `${k}=${q.params[k]}`)
    .join("&");
  return `GET ${q.api} ${q.path}${params === "" ? "" : `?${params}`}`;
}

export const queryId = (q: Query): string =>
  createHash("sha256").update(canonicalQuery(q)).digest("hex");

/** The group a query's requests are governed under. */
export const governorGroup = (q: Query): "data-api" | "token-unlocks" =>
  q.api === "data" ? "data-api" : "token-unlocks";

const segment = (s: string, label: string): string => {
  if (!/^[A-Za-z0-9._~-]+$/.test(s))
    throw new TypeError(`${label} must be a plain identifier, got ${JSON.stringify(s)}`);
  return s;
};

function tabular(model: string, params: Record<string, string> = {}, row?: string): Query {
  const path = `/query/tabular/${segment(model, "model")}${row === undefined ? "" : `/${segment(row, "row key")}`}`;
  return validateQuery({ api: "data", path, params });
}

function timeseries(input: {
  model: string;
  series: readonly string[];
  selections: readonly string[];
  start: string;
  end: string;
  bounds?: boolean;
}): Query {
  if (input.series.length === 0)
    throw new RangeError(
      "a timeseries pull must name its series: an unnamed pull returns every series and would exceed the point limit",
    );
  if (input.series.length > MAX_SERIES_PER_CALL)
    throw new RangeError(
      `at most ${MAX_SERIES_PER_CALL} series per call, got ${input.series.length}`,
    );
  assertDate(input.start, "start");
  assertDate(input.end, "end");
  const days = daysBetween(input.start, input.end);
  if (days <= 0) throw new RangeError(`end ${input.end} must be after start ${input.start}`);
  const points = input.bounds === true ? 2 * input.series.length : days * input.series.length;
  if (points > MAX_POINTS_PER_CALL)
    throw new RangeError(
      `${input.series.length} series over ${days} days is ${points} points, over the ${MAX_POINTS_PER_CALL} per call`,
    );
  return validateQuery({
    api: "data",
    path: `/query/timeseries/${segment(input.model, "model")}/1d`,
    params: {
      series: input.series.map((s) => segment(s, "series key")).join(","),
      selections: input.selections.join(","),
      start: input.start,
      end: input.end,
      ...(input.bounds === true ? { bounds: "true" } : {}),
    },
  });
}

const rfc3339 = (date: string): string => `${assertDate(date)}T00:00:00Z`;

export const catalog = {
  /** CR-VS: the perp venues, then their daily volume. */
  perpVenues: (): Query => tabular("perp-dex-protocols", { pageSize: String(MAX_PAGE_SIZE) }),
  perpVolume: (seriesKeys: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "perp-dex-protocols",
      series: seriesKeys,
      selections: ["volumeUSD"],
      start,
      end,
    }),

  /** CR-PL: lending protocols (D89), then one protocol's daily fees, interest and revenue. */
  lendingProtocols: (): Query => tabular("lending-protocols", { pageSize: String(MAX_PAGE_SIZE) }),
  lendingFinancials: (protocolId: string, start: string, end: string): Query =>
    timeseries({
      model: "lending-protocols",
      series: [protocolId],
      selections: ["fees-usd", "revenue-usd", "interest-usd", "net-interest-income-usd"],
      start,
      end,
    }),

  /** CR-UO: the token list, one token's identifier, its unlock events or schedule, and its circulating supply. */
  tokenUnlockAssets: (): Query => ({
    api: "token-unlocks",
    path: "/token-unlocks/v1/assets",
    params: {},
  }),
  assetBySlug: (slug: string): Query =>
    tabular("assets", { selections: "assetID,name,symbol" }, slug),
  tokenUnlockEvents: (assetId: string, start: string, end: string): Query =>
    validateQuery({
      api: "token-unlocks",
      path: `/token-unlocks/v1/assets/${segment(assetId, "assetId")}/events`,
      params: { startTime: rfc3339(start), endTime: rfc3339(end) },
    }),
  tokenUnlockSchedule: (
    assetId: string,
    interval: "DAILY" | "WEEKLY" | "MONTHLY",
    start: string,
    end: string,
  ): Query =>
    validateQuery({
      api: "token-unlocks",
      path: `/token-unlocks/v1/assets/${segment(assetId, "assetId")}/unlocks`,
      params: { interval, startTime: rfc3339(start), endTime: rfc3339(end) },
    }),
  assetSupply: (assetId: string, start: string, end: string): Query =>
    timeseries({
      model: "asset-supply",
      series: [assetId],
      selections: ["circulating-supply"],
      start,
      end,
    }),

  /** CR-SM (option A, D90): the stablecoin contracts by chain and issuer, then their supply and price at the two ends of the window. */
  stablecoinContracts: (page: number): Query => {
    if (!Number.isInteger(page) || page < 1)
      throw new RangeError(`page must be a positive integer, got ${page}`);
    return tabular("project-tokens", {
      categoryEq: "stablecoins",
      page: String(page),
      pageSize: String(MAX_PAGE_SIZE),
    });
  },
  stablecoinSupply: (contractIds: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "project-tokens",
      series: contractIds,
      selections: ["supplyTotal", "priceUSD"],
      start,
      end,
      bounds: true,
    }),
};

/**
 * What the fixtures assume beyond what the public docs state. Day 1's calibration checks each against the live API; a mismatch is then a one-file fix in the extractors,
 * not a redesign. (`ASSUMED_SHAPES` is also what the fixtures' own test lists, so the list cannot drift from the code.)
 */
export const ASSUMED_SHAPES: readonly string[] = [
  "tabular response: `data` is an array of row objects and `metadata` holds `totalRows` and `totalPages` (stated); the row field names (`id`, `name`, `slug`, `projectID`, `chain`, `issuerID`, `category`, `networkID`) are from the per-model pages",
  "tabular single-row endpoint `/query/tabular/assets/{slug}`: `data` is assumed to be a one-element array (it may be an object)",
  "timeseries `point_schema`: the first entry is the time (stated); the other entries' `field` names equal the `selections` asked for",
  "`GET /token-unlocks/v1/assets`: assumed `data` is an array of asset objects with `id`, `slug`, `symbol`",
  "`/token-unlocks/v1/assets/{id}/events`: `data.unlockEvents[]` with `timestamp` and one of `cliff` or `dailyLinearRateChange` (stated); how a `dailyLinearRateChange` converts to an amount over a window is NOT stated",
  "`/token-unlocks/v1/assets/{id}/unlocks`: `data.totalSnapshots[]` with `timestamp`, `unlockedInPeriodNative`, `unlockedInPeriodUSD` (stated); that future periods are included is assumed",
  "`bounds=true` returns only the first and last point of each series (stated); that `end` stays exclusive with it is assumed",
  "`project-tokens` rows for stablecoins carry `chain`, `issuerID` and a `category` that equals `stablecoins` under the `categoryEq` filter (filter syntax stated)",
];
