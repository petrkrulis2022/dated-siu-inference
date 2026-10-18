/**
 * A fake Blockworks MCP server over the fixtures backend, so the MCP loop can be built and tested before the owner has signed in to the real one (D91). It offers the four data tools with the
 * limits the public docs state, and relays the fixtures' API-shaped JSON as the tool result text. What the docs do not state is ASSUMED, and the live server may differ (the first live sign-in
 * checks each one):
 *  - a tool result is the Data API's response body, as text;
 *  - the fake is stricter than the docs in two places because the fixtures backend is: `timeseries_data` needs named series (at most 10, where the docs say 10 or 20) and no call may run
 *    over 9,000 points; a refused call comes back as an error result and is never truncated.
 * `today` is the snapshot day. A `timeframe` such as `90d` is that many days ending on the latest published day, which is `today` less `lagDays` (0 by default; 1 mimics the live data, which
 * publishes a day late: on 2026-10-17 `90d` began on 2026-07-19 and ended on 2026-10-16).
 */
import { addDays, assertDate, firstOfMonth, monthsBefore } from "../data-desk/dates.js";
import { MAX_SERIES_PER_CALL } from "../data-desk/queries.js";
import type { DataBackend, Query } from "../data-desk/types.js";
import type { McpBackend, McpCallResult, McpToolDef } from "./types.js";

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const ok = (text: string): McpCallResult => ({ isError: false, text });
const err = (text: string): McpCallResult => ({ isError: true, text });

const TIMESERIES = [
  { model: "perp-dex-protocols", granularities: ["1d"], fields: ["volumeUSD"] },
  {
    model: "lending-protocols",
    granularities: ["1d"],
    fields: [
      "interest-usd",
      "net-interest-income-usd",
      "flash-loan-fees-usd",
      "liquidation-fees-usd",
      "royalties-usd",
      "fees-usd",
      "revenue-usd",
    ],
  },
  { model: "asset-supply", granularities: ["1d"], fields: ["circulating-supply"] },
  { model: "stablecoins-by-chain", granularities: ["1d"], fields: ["circulatingSupplyUSD"] },
  { model: "stablecoins-by-issuer", granularities: ["1d"], fields: ["circulatingSupplyUSD"] },
] as const;

const TABULAR = [
  { model: "perp-dex-protocols", columns: ["id", "name", "slug", "projectID"] },
  { model: "lending-protocols", columns: ["id", "name"] },
  { model: "stablecoin-chains", columns: ["id", "name", "slug", "networkID"] },
  { model: "stablecoin-issuers", columns: ["id", "name", "slug", "projectID"] },
] as const;

const TOOLS: McpToolDef[] = [
  {
    name: "tabular_catalog",
    description: "List the tabular models (tables) available, with their columns.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "tabular_data",
    description:
      "Read rows of a tabular model. Paged: `page` (from 1) and `pageSize` (at most 200).",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        page: { type: "integer", minimum: 1 },
        pageSize: { type: "integer", minimum: 1, maximum: 200 },
      },
      required: ["model"],
      additionalProperties: false,
    },
  },
  {
    name: "timeseries_catalog",
    description: "List the timeseries models available, with their granularities and fields.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "timeseries_data",
    description:
      "Read a timeseries model. Name the `series` (entity ids, at most 10 per call) and a window: `timeframe` (`90d`, `ytd` or `YYYY-MM`, default `90d`) or an explicit `start` (inclusive) and `end` (exclusive) as YYYY-MM-DD. `bounds` true returns only each series' first and last point. A call over 9,000 points is refused, not truncated.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        granularity: { type: "string" },
        series: { type: "array", items: { type: "string" }, maxItems: MAX_SERIES_PER_CALL },
        timeframe: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        bounds: { type: "boolean" },
      },
      required: ["model", "granularity", "series"],
      additionalProperties: false,
    },
  },
];

export class FakeMcp implements McpBackend {
  readonly name = "fake" as const;
  /** every call received, in order: tests read this */
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly #backend: DataBackend;
  readonly #today: string;
  readonly #latest: string;

  constructor(opts: { backend: DataBackend; today: string; lagDays?: number }) {
    this.#backend = opts.backend;
    this.#today = assertDate(opts.today, "today");
    this.#latest = addDays(this.#today, -(opts.lagDays ?? 0));
  }

  async tools(): Promise<McpToolDef[]> {
    return TOOLS.map((t) => structuredClone(t));
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args: structuredClone(args) });
    switch (name) {
      case "tabular_catalog":
        return ok(JSON.stringify({ models: TABULAR }));
      case "timeseries_catalog":
        return ok(JSON.stringify({ models: TIMESERIES }));
      case "tabular_data":
        return this.#tabular(args);
      case "timeseries_data":
        return this.#timeseries(args);
      default:
        return err(`unknown tool ${JSON.stringify(name).slice(0, 60)}`);
    }
  }

  async #get(query: Query): Promise<McpCallResult> {
    try {
      const res = await this.#backend.get(query);
      return res.status === 200 ? ok(dec(res.body)) : err(dec(res.body));
    } catch (e) {
      return err(e instanceof Error ? e.message : "request refused");
    }
  }

  async #tabular(a: Record<string, unknown>): Promise<McpCallResult> {
    const model = a.model;
    if (typeof model !== "string" || !TABULAR.some((t) => t.model === model))
      return err(
        `unknown tabular model ${JSON.stringify(model).slice(0, 60)}; see tabular_catalog`,
      );
    const params: Record<string, string> = {};
    if (a.page !== undefined) params.page = String(a.page);
    if (a.pageSize !== undefined) {
      if (typeof a.pageSize !== "number" || a.pageSize > 200 || a.pageSize < 1)
        return err("pageSize must be 1 to 200");
      params.pageSize = String(a.pageSize);
    }
    return this.#get({ api: "data", path: `/query/tabular/${model}`, params });
  }

  async #timeseries(a: Record<string, unknown>): Promise<McpCallResult> {
    const { model, granularity, series } = a;
    if (typeof model !== "string" || !TIMESERIES.some((t) => t.model === model))
      return err(
        `unknown timeseries model ${JSON.stringify(model).slice(0, 60)}; see timeseries_catalog`,
      );
    if (granularity !== "1d") return err('granularity must be "1d" for this model');
    if (
      !Array.isArray(series) ||
      series.length === 0 ||
      !series.every((s) => typeof s === "string" && s !== "")
    )
      return err("series must be a non-empty list of entity ids");
    if (series.length > MAX_SERIES_PER_CALL)
      return err(
        `at most ${MAX_SERIES_PER_CALL} series per call; this call named ${series.length}`,
      );
    let start: string;
    let end: string;
    try {
      if (typeof a.start === "string" || typeof a.end === "string") {
        if (typeof a.start !== "string" || typeof a.end !== "string")
          return err("give both start and end, or a timeframe");
        start = assertDate(a.start, "start");
        end = assertDate(a.end, "end");
      } else {
        const tf = typeof a.timeframe === "string" ? a.timeframe : "90d";
        let m: RegExpExecArray | null;
        if ((m = /^(\d{1,4})d$/.exec(tf)) !== null) {
          start = addDays(this.#latest, -(Number(m[1]) - 1));
          end = addDays(this.#latest, 1);
        } else if (tf === "ytd") {
          start = `${this.#latest.slice(0, 4)}-01-01`;
          end = addDays(this.#latest, 1);
        } else if (/^\d{4}-\d{2}$/.test(tf)) {
          start = firstOfMonth(`${tf}-01`);
          end = monthsBefore(start, -1);
        } else return err(`unsupported timeframe ${JSON.stringify(tf).slice(0, 30)}`);
      }
    } catch (e) {
      return err(e instanceof Error ? e.message : "bad date");
    }
    const params: Record<string, string> = { series: series.join(","), start, end };
    if (a.bounds === true) params.bounds = "true";
    return this.#get({ api: "data", path: `/query/timeseries/${model}/1d`, params });
  }
}
