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
  /** Calibration only (day 1): a timeseries pull with any selections, to check a field's meaning. The tasks use the builders below, never this. */
  probeTimeseries: (
    model: string,
    seriesKeys: readonly string[],
    selections: readonly string[],
    start: string,
    end: string,
    bounds = false,
  ): Query => timeseries({ model, series: seriesKeys, selections, start, end, bounds }),

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
  lendingFinancials: (protocolIds: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "lending-protocols",
      series: protocolIds,
      selections: ["fees-usd", "revenue-usd", "interest-usd", "net-interest-income-usd"],
      start,
      end,
    }),

  /** CR-UO: the token list, one token's identifier, its unlock events or schedule, and its circulating supply (a batch of up to 10 tokens in one call). */
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
  assetSupply: (assetIds: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "asset-supply",
      series: assetIds,
      selections: ["circulating-supply"],
      start,
      end,
    }),

  /**
   * CR-SM, option B (D90, D94): stablecoins are ranked among chains and, separately, among issuers. Option A (chain x issuer pairs from `project-tokens`) is not available with this key:
   * calibration on 2026-10-17 found that model holds only the categories `projects` and `blockchains`. The tabular models are `stablecoin-chains` and `stablecoin-issuers`; the
   * timeseries models `stablecoins-by-chain` and `stablecoins-by-issuer` (daily only, keyed by `id`, each summed across the other dimension). `bounds` returns just the first and
   * last day, which is all a 90-day change needs. Not yet requested live: the first daily snapshot is its first real run.
   */
  stablecoinChains: (): Query => tabular("stablecoin-chains", { pageSize: String(MAX_PAGE_SIZE) }),
  stablecoinIssuers: (): Query =>
    tabular("stablecoin-issuers", { pageSize: String(MAX_PAGE_SIZE) }),
  stablecoinsByChain: (chainIds: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "stablecoins-by-chain",
      series: chainIds,
      selections: ["circulatingSupplyUSD"],
      start,
      end,
      bounds: true,
    }),
  stablecoinsByIssuer: (issuerIds: readonly string[], start: string, end: string): Query =>
    timeseries({
      model: "stablecoins-by-issuer",
      series: issuerIds,
      selections: ["circulatingSupplyUSD"],
      start,
      end,
      bounds: true,
    }),
};

/**
 * What day-1 calibration confirmed against the LIVE API (2026-10-17, `docs/marketplace_plan.md` D94). The fixtures are built to these, and tests keep them so.
 */
export const CONFIRMED_SHAPES: readonly string[] = [
  "tabular: `data` is an array of row objects and `metadata` holds `totalRows` and `totalPages`; a single-row endpoint (`/query/tabular/assets/{slug}`) returns `data` as ONE OBJECT and `metadata.matchedField`",
  "timeseries: `data.point_schema` lists the time first and then each selected field by name; each series is `{key, entity, points}`, points are `[unix seconds, value, ...]`, one per day; `start` is inclusive and `end` exclusive",
  "the perp venues' `id` is always present; `slug` and `projectID` are null for some venues (8 of 31): key on `id`",
  "numbers arrive as float64 text with up to about 19 decimal digits; zeros can be written as plain integers",
  "lending: fees - revenue = interest - net interest income holds on every day tested to within 1e-9 relative (float noise); a protocol can have a partial quarter (61 of 92 days)",
  "Token Unlocks `GET /assets` returns `data` as an array (254 assets), each with a `slug`",
  "Token Unlocks `/events`: `data` is `{asset, unlockEvents[]}`; an empty window is an empty list, not `data: null`; a `cliff` has amountNative, amountUSD, percentOfTotalAllocation, allocations",
  "a `dailyLinearRateChange` has `dailyAmountNative` (the rate before), `nextDailyAmountNative` (the rate after), percentChangeOfRate and allocations, and NO `amountNative`; the rate in effect on a day is the `nextDailyAmountNative` of the latest such event on or before it (it reproduced the schedule on 31 of 31 days)",
  "Token Unlocks `/unlocks`: `endTime` is INCLUSIVE (31 calendar days give 31 daily snapshots), future periods are included, and a window that starts before genesis or after `projectedEndDate` is a 400",
  "`asset-supply` is keyed by the asset's UUID (`assetID`) and carries `circulating-supply`",
  "the API answers `429 Too Many Requests` (body `{error}`, no `Retry-After`, no rate-limit headers) after bursts; the limit is not known",
];

/** Still assumed, not yet seen on the live API. */
export const ASSUMED_SHAPES: readonly string[] = [
  "stablecoins by chain and by issuer (CR-SM option B): the model names, series keys and field names (`circulatingSupplyUSD`) are from the docs, not yet requested",
  "`bounds=true` returns only the first and last point of each series, and `end` stays exclusive with it",
  "whether a null figure ever appears in a perp or lending point (none was seen in the venues and protocols tested)",
  "the MCP server's tool list and result shapes (the MCP needs a browser sign-in, D91)",
];
