/**
 * A fake Blockworks MCP server over the fixtures backend, so the MCP loop can be built and tested without spending, and without Blockworks' data. It follows the contract the live server's own
 * tool descriptions and catalogs state (read 2026-10-18, D105):
 *  - `timeseries_data` reads at most 20 series and at most 5,000 points across all series in a call, and REFUSES a call over either limit rather than shortening it;
 *  - `series` may be left out only for a model whose catalog entry says `allowAllSeries: true`, and then every series is read;
 *  - a window is a `timeframe` (30d, 4w, ytd, qtd, mtd, dtd, or a calendar 2026, 2026-09, 2026-09-15) OR a `start` (inclusive) and `end` (exclusive), never both; with neither it is the last 90 days;
 *  - `selections` names the metric fields each point should carry; left out, a point carries EVERY metric the model has, which for the volume model is 96 (the live catalog's count). That is the big
 *    cost trap, so the fake pads points to the live metric counts with synthetic columns, to give tool results their live size (a padding value is about as long as a live float, since a live point of one metric is about 31 bytes);
 *  - a data result is JSON text in the MCP's own envelope, not the Data API's body (seen on the first live data read, 2026-10-20, D116): `timeseries_data` gives `{model, granularity, point_schema,
 *    series, totalPoints}` and `tabular_data` gives `{model, rows, totalRows, totalPages, page, pageSize}`. The catalogs here are flatter than the live ones (`{model: {...}}`); a catalog is never graded.
 * ASSUMED, not seen live: the names of the padding metrics, how `granularity` behaves for a model with one interval, and tabular filters (not implemented: refused). SEEN live: a call that names more than
 * 10 series is refused ("too many series requested: 20 exceeds the maximum of 10") although the tool description says 20; the fake keeps the documented 20 until the live limit is better understood.
 * `today` is the snapshot day. A relative timeframe ends on the model's latest published day: `today` less its lag (`lagByModel`; `LIVE_LAG` mimics the live stablecoin series, a day late).
 * Give the fixtures backend the same lag, or the snapshot and the server will disagree about the latest day.
 */
import {
  addDays,
  assertDate,
  daysBetween,
  firstOfMonth,
  monthsBefore,
} from "../data-desk/dates.js";
import {
  Num,
  parseJsonDecimal,
  stringifyJsonDecimal,
  type Json,
} from "../data-desk/json-decimal.js";
import { MAX_SERIES_PER_CALL } from "../data-desk/queries.js";
import type { DataBackend, Query } from "../data-desk/types.js";
import type { McpBackend, McpCallResult, McpToolDef } from "./types.js";

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const ok = (text: string): McpCallResult => ({ isError: false, text });
const err = (text: string): McpCallResult => ({ isError: true, text });

/** The live data's publication lag by timeseries model, as seen on 2026-10-17. */
export const LIVE_LAG: Readonly<Record<string, number>> = {
  "stablecoins-by-chain": 1,
  "stablecoins-by-issuer": 1,
};

/** What the live server limits one call to. It ADVERTISES 20 series (schema and description) and applies 20 to a read that leaves out `series`, but refuses a call that NAMES more than 10 (seen live, 2026-10-20). */
export const MCP_MAX_SERIES = 20;
export const MCP_MAX_NAMED_SERIES = 10;
export const MCP_MAX_POINTS = 5_000;

interface TimeseriesModel {
  slug: string;
  name: string;
  description: string;
  permissionSlug: string;
  intervals: string[];
  allowAllSeries: boolean;
  /** the fields the fixtures serve, which the solvers read */
  fields: string[];
  /** the live catalog's metric count: points are padded with synthetic columns up to it when no `selections` are given */
  liveMetricCount: number;
  /** the fixtures' tabular model that lists this model's series keys */
  keys: string;
}

const TIMESERIES: TimeseriesModel[] = [
  {
    slug: "perp-dex-protocols",
    name: "Perp DEX protocols",
    description: "Daily metrics of perpetual-futures DEX protocols, one series per protocol.",
    permissionSlug: "projects_protocols_unified",
    intervals: ["1d"],
    allowAllSeries: true,
    fields: ["volumeUSD"],
    liveMetricCount: 96,
    keys: "perp-dex-protocols",
  },
  {
    slug: "lending-protocols",
    name: "Lending protocols",
    description: "Daily financials of lending protocols, one series per protocol.",
    permissionSlug: "projects_protocols_unified",
    intervals: ["1d"],
    allowAllSeries: true,
    fields: [
      "interest-usd",
      "net-interest-income-usd",
      "flash-loan-fees-usd",
      "liquidation-fees-usd",
      "royalties-usd",
      "fees-usd",
      "revenue-usd",
    ],
    liveMetricCount: 10,
    keys: "lending-protocols",
  },
  {
    slug: "asset-supply",
    name: "Asset supply",
    description:
      "Circulating and total token supply of an asset over time. Each series is one asset, keyed by its asset id.",
    permissionSlug: "market_data_unified",
    intervals: ["1d", "1w"],
    allowAllSeries: false,
    fields: ["circulating-supply", "total-supply"],
    liveMetricCount: 2,
    keys: "",
  },
  {
    slug: "stablecoins-by-chain",
    name: "Stablecoins by chain",
    description: "Daily stablecoin supply by chain, one series per chain.",
    permissionSlug: "stablecoins_unified",
    intervals: ["1d"],
    allowAllSeries: true,
    fields: ["stablecoinCount", "circulatingSupplyUSD"],
    liveMetricCount: 35,
    keys: "stablecoin-chains",
  },
  {
    slug: "stablecoins-by-issuer",
    name: "Stablecoins by issuer",
    description: "Daily stablecoin supply by issuer, one series per issuer.",
    permissionSlug: "stablecoins_unified",
    intervals: ["1d"],
    allowAllSeries: true,
    fields: ["chainCount", "stablecoinCount", "circulatingSupplyUSD"],
    liveMetricCount: 36,
    keys: "stablecoin-issuers",
  },
];

const TABULAR = [
  {
    slug: "perp-dex-protocols",
    columns: ["id", "name", "slug", "projectID"],
    permissionSlug: "projects_protocols_unified",
  },
  {
    slug: "lending-protocols",
    columns: ["id", "name"],
    permissionSlug: "projects_protocols_unified",
  },
  {
    slug: "stablecoin-chains",
    columns: ["id", "name", "slug", "networkID"],
    permissionSlug: "stablecoins_unified",
  },
  {
    slug: "stablecoin-issuers",
    columns: ["id", "name", "slug", "projectID"],
    permissionSlug: "stablecoins_unified",
  },
] as const;

const padNames = (m: TimeseriesModel): string[] =>
  Array.from(
    { length: Math.max(0, m.liveMetricCount - m.fields.length) },
    (_, i) => `extra-metric-${String(i + 1).padStart(2, "0")}`,
  );
const allMetrics = (m: TimeseriesModel): string[] => [...m.fields, ...padNames(m)];

const TOOLS: McpToolDef[] = [
  {
    name: "tabular_catalog",
    description:
      "List the tabular datasets this server serves, or describe one in full. Pass `model` for one model's columns, or `search` to narrow the list.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string" }, search: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "tabular_data",
    description:
      "Read rows from one tabular dataset, paginated: at most 200 rows (25 by default) plus totalRows and totalPages. Use it for entity lists and to turn a name into a series key.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        selections: { type: "array", items: { type: "string" } },
        page: { type: ["null", "integer"] },
        pageSize: { type: ["null", "integer"] },
        sortBy: { type: "string" },
        sortDirection: { type: "string" },
        filters: { type: "array", items: { type: "object" } },
      },
      required: ["model"],
      additionalProperties: false,
    },
  },
  {
    name: "timeseries_catalog",
    description:
      "List the time-series datasets this server serves, or describe one in full: the exact slug, the granularities, the metric fields, and whether every series can be read at once (allowAllSeries). Pass `model` for one model's full metric list, or `search` to narrow the list.",
    inputSchema: {
      type: "object",
      properties: { model: { type: "string" }, search: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: "timeseries_data",
    description:
      "Read points from one time-series dataset over a window. Choose either `timeframe` (30d, 4w, ytd, qtd, mtd, dtd, or a calendar 2026, 2026-09, 2026-09-15) or `start` and `end`, never both; the default is the last 90 days. At most 20 `series` and at most 5000 points across all series per call: a larger call is rejected, not shortened. Omit `series` only for a model whose catalog says allowAllSeries. `selections` names the metric fields each point carries; omit it and every metric comes back. `bounds` true returns only each series' first and last point.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        granularity: { type: "string" },
        series: {
          type: "array",
          description:
            "Series keys to read, at most 20. Omit for every series, which only models with allowAllSeries true support.",
          items: { type: "string" },
        },
        selections: { type: "array", items: { type: "string" } },
        timeframe: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        bounds: { type: "boolean" },
      },
      required: ["model"],
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
  readonly #lag: Readonly<Record<string, number>>;

  constructor(opts: {
    backend: DataBackend;
    today: string;
    lagByModel?: Readonly<Record<string, number>>;
  }) {
    this.#backend = opts.backend;
    this.#today = assertDate(opts.today, "today");
    this.#lag = opts.lagByModel ?? {};
  }

  async tools(): Promise<McpToolDef[]> {
    return TOOLS.map((t) => structuredClone(t));
  }

  async call(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.calls.push({ name, args: structuredClone(args) });
    switch (name) {
      case "tabular_catalog":
        return this.#tabularCatalog(args);
      case "timeseries_catalog":
        return this.#timeseriesCatalog(args);
      case "tabular_data":
        return this.#tabular(args);
      case "timeseries_data":
        return this.#timeseries(args);
      default:
        return err(`unknown tool ${JSON.stringify(name).slice(0, 60)}`);
    }
  }

  async #get(query: Query): Promise<McpCallResult & { status: number }> {
    try {
      const res = await this.#backend.get(query);
      return {
        status: res.status,
        ...(res.status === 200 ? ok(dec(res.body)) : err(dec(res.body))),
      };
    } catch (e) {
      return { status: 400, ...err(e instanceof Error ? e.message : "request refused") };
    }
  }

  #timeseriesCatalog(a: Record<string, unknown>): McpCallResult {
    const compact = (m: TimeseriesModel) => ({
      slug: m.slug,
      name: m.name,
      description: m.description,
      access: { tier: "", permissionSlug: m.permissionSlug },
      metricCount: m.liveMetricCount,
      intervals: m.intervals,
      allowAllSeries: m.allowAllSeries,
    });
    if (typeof a.model === "string") {
      const m = TIMESERIES.find((x) => x.slug === a.model);
      if (m === undefined)
        return err(`unknown timeseries model ${JSON.stringify(a.model).slice(0, 60)}`);
      return ok(
        JSON.stringify({
          ...compact(m),
          metrics: allMetrics(m).map((field) => ({
            field,
            description: `fixture metric ${field}`,
          })),
        }),
      );
    }
    const q = typeof a.search === "string" ? a.search.toLowerCase() : undefined;
    const models = TIMESERIES.filter(
      (m) => q === undefined || `${m.slug} ${m.name} ${m.description}`.toLowerCase().includes(q),
    );
    return ok(JSON.stringify({ models: models.map(compact) }));
  }

  #tabularCatalog(a: Record<string, unknown>): McpCallResult {
    const compact = (t: (typeof TABULAR)[number]) => ({
      slug: t.slug,
      name: t.slug,
      description: `fixture table ${t.slug}`,
      access: { tier: "", permissionSlug: t.permissionSlug },
      columnCount: t.columns.length,
    });
    if (typeof a.model === "string") {
      const t = TABULAR.find((x) => x.slug === a.model);
      if (t === undefined)
        return err(`unknown tabular model ${JSON.stringify(a.model).slice(0, 60)}`);
      return ok(
        JSON.stringify({
          ...compact(t),
          columns: t.columns.map((field) => ({ field, sortable: true })),
        }),
      );
    }
    const q = typeof a.search === "string" ? a.search.toLowerCase() : undefined;
    return ok(
      JSON.stringify({
        models: TABULAR.filter((t) => q === undefined || t.slug.includes(q)).map(compact),
      }),
    );
  }

  async #tabular(a: Record<string, unknown>): Promise<McpCallResult> {
    const model = a.model;
    if (typeof model !== "string" || !TABULAR.some((t) => t.slug === model))
      return err(
        `unknown tabular model ${JSON.stringify(model).slice(0, 60)}; see tabular_catalog`,
      );
    if (a.filters !== undefined && !(Array.isArray(a.filters) && a.filters.length === 0))
      return err("the fake server does not implement filters; page through the rows instead");
    const params: Record<string, string> = { pageSize: "25" };
    if (typeof a.page === "number") params.page = String(a.page);
    if (a.pageSize !== undefined && a.pageSize !== null) {
      if (typeof a.pageSize !== "number" || a.pageSize > 200 || a.pageSize < 1)
        return err("pageSize must be 1 to 200");
      params.pageSize = String(a.pageSize);
    }
    const r = await this.#get({ api: "data", path: `/query/tabular/${model}`, params });
    if (r.isError) return r;
    // the live envelope (first live session, 2026-10-20): the rows and the paging at the top level, not `data` and `metadata`
    const body = parseJsonDecimal(r.text) as {
      data: Json;
      metadata?: { totalRows?: Json; totalPages?: Json };
    };
    return ok(
      stringifyJsonDecimal({
        model,
        rows: body.data,
        totalRows: body.metadata?.totalRows ?? null,
        totalPages: body.metadata?.totalPages ?? null,
        page: new Num(params.page ?? "1"),
        pageSize: new Num(params.pageSize ?? "25"),
      } as Json),
    );
  }

  /** The start (inclusive) and end (exclusive) of a window, from a `timeframe` or from `start` and `end`. */
  #window(
    model: TimeseriesModel,
    a: Record<string, unknown>,
  ): { start: string; end: string } | string {
    const hasTf = typeof a.timeframe === "string";
    const hasRange = a.start !== undefined || a.end !== undefined;
    if (hasTf && hasRange) return "give either timeframe, or start and end: never both";
    try {
      if (hasRange) {
        if (typeof a.start !== "string" || typeof a.end !== "string")
          return "give both start and end, or a timeframe";
        const start = assertDate(a.start, "start");
        const end = assertDate(a.end, "end");
        return daysBetween(start, end) > 0 ? { start, end } : "end must be after start";
      }
      const tf = hasTf ? (a.timeframe as string) : "90d";
      const latest = addDays(this.#today, -(this.#lag[model.slug] ?? 0));
      let m: RegExpExecArray | null;
      if ((m = /^(\d{1,4})d$/.exec(tf)) !== null)
        return { start: addDays(latest, -(Number(m[1]) - 1)), end: addDays(latest, 1) };
      if ((m = /^(\d{1,3})w$/.exec(tf)) !== null)
        return { start: addDays(latest, -(Number(m[1]) * 7 - 1)), end: addDays(latest, 1) };
      if (tf === "dtd") return { start: latest, end: addDays(latest, 1) };
      if (tf === "mtd") return { start: firstOfMonth(latest), end: addDays(latest, 1) };
      if (tf === "ytd") return { start: `${latest.slice(0, 4)}-01-01`, end: addDays(latest, 1) };
      if (tf === "qtd") {
        const month = Number(latest.slice(5, 7));
        const qStart = `${latest.slice(0, 4)}-${String(Math.floor((month - 1) / 3) * 3 + 1).padStart(2, "0")}-01`;
        return { start: qStart, end: addDays(latest, 1) };
      }
      if (/^\d{4}$/.test(tf)) return { start: `${tf}-01-01`, end: `${Number(tf) + 1}-01-01` };
      if (/^\d{4}-\d{2}$/.test(tf)) {
        const start = firstOfMonth(`${tf}-01`);
        return { start, end: monthsBefore(start, -1) };
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(tf))
        return { start: assertDate(tf, "timeframe"), end: addDays(tf, 1) };
      return `unsupported timeframe ${JSON.stringify(tf).slice(0, 30)}: use 30d, 4w, ytd, qtd, mtd, dtd, or a calendar 2026, 2026-09, 2026-09-15`;
    } catch (e) {
      return e instanceof Error ? e.message : "bad date";
    }
  }

  async #allKeys(model: TimeseriesModel): Promise<string[] | string> {
    const r = await this.#get({
      api: "data",
      path: `/query/tabular/${model.keys}`,
      params: { pageSize: "1000" },
    });
    if (r.isError) return "could not list the series";
    return (JSON.parse(r.text) as { data: { id: string }[] }).data.map((row) => row.id);
  }

  async #timeseries(a: Record<string, unknown>): Promise<McpCallResult> {
    const model = TIMESERIES.find((m) => m.slug === a.model);
    if (model === undefined)
      return err(
        `unknown timeseries model ${JSON.stringify(a.model).slice(0, 60)}; see timeseries_catalog`,
      );
    const granularity = a.granularity === undefined ? "1d" : a.granularity;
    if (typeof granularity !== "string" || !model.intervals.includes(granularity))
      return err(`granularity must be one of ${model.intervals.join(", ")} for ${model.slug}`);
    if (granularity !== "1d") return err("this fake serves daily points only");

    let series: string[];
    if (a.series === undefined) {
      if (!model.allowAllSeries)
        return err(
          `${model.slug} cannot return every series at once (allowAllSeries is false): name the series keys`,
        );
      const all = await this.#allKeys(model);
      if (typeof all === "string") return err(all);
      if (all.length > MCP_MAX_SERIES)
        return err(
          `Error: this read returned ${all.length} series, over the ${MCP_MAX_SERIES}-series limit for one call: name the specific series you need in the series argument`,
        );
      series = all;
    } else {
      if (
        !Array.isArray(a.series) ||
        a.series.length === 0 ||
        !a.series.every((s) => typeof s === "string" && s !== "")
      )
        return err("series must be a non-empty list of series keys");
      if (a.series.length > MCP_MAX_NAMED_SERIES)
        return err(
          `Error: too many series requested: ${a.series.length} exceeds the maximum of ${MCP_MAX_NAMED_SERIES}`,
        );
      series = a.series as string[];
    }

    const win = this.#window(model, a);
    if (typeof win === "string") return err(win);
    const days = daysBetween(win.start, win.end);
    const points = a.bounds === true ? 2 * series.length : days * series.length;
    if (points > MCP_MAX_POINTS)
      return err(
        `rejected: this call would return ${points} points, over the ${MCP_MAX_POINTS}-point limit. Shorten the timeframe, name fewer series, select fewer metrics, or set bounds true.`,
      );

    let selections: string[] | undefined;
    if (a.selections !== undefined) {
      if (!Array.isArray(a.selections) || !a.selections.every((s) => typeof s === "string"))
        return err("selections must be a list of metric fields");
      const valid = allMetrics(model);
      const bad = (a.selections as string[]).find((s) => !valid.includes(s));
      if (bad !== undefined)
        return err(
          `unknown metric ${JSON.stringify(bad).slice(0, 40)} for ${model.slug}; see timeseries_catalog`,
        );
      selections = a.selections as string[];
    }
    // the fixtures serve only the real fields; padding columns are added back here
    const real =
      selections === undefined ? model.fields : selections.filter((s) => model.fields.includes(s));
    const pads =
      selections === undefined
        ? padNames(model)
        : selections.filter((s) => !model.fields.includes(s));
    if (real.length === 0)
      return err("the fake serves only the fixtures' own metrics: select at least one of them");

    const chunks: string[][] = [];
    for (let i = 0; i < series.length; i += MAX_SERIES_PER_CALL)
      chunks.push(series.slice(i, i + MAX_SERIES_PER_CALL));
    let schema: Json[] | undefined;
    const merged: Json[] = [];
    for (const chunk of chunks) {
      const params: Record<string, string> = {
        series: chunk.join(","),
        start: win.start,
        end: win.end,
        selections: real.join(","),
      };
      if (a.bounds === true) params.bounds = "true";
      const r = await this.#get({
        api: "data",
        path: `/query/timeseries/${model.slug}/1d`,
        params,
      });
      if (r.isError) return err(r.text);
      const body = parseJsonDecimal(r.text) as { data: { point_schema: Json[]; series: Json[] } };
      schema ??= body.data.point_schema;
      merged.push(...body.data.series);
    }
    const padSchema: Json[] = pads.map((field) => ({
      name: field,
      field,
      description: `synthetic padding metric ${field}`,
      type: "float64",
    }));
    const padded = merged.map((s) => {
      const row = s as { points: Json[][] };
      return {
        ...(s as object),
        points: row.points.map((p) => [...p, ...pads.map(() => new Num("123456789.1234"))]),
      } as Json;
    });
    // the live envelope (first live session, 2026-10-20): no `data` wrapper, and a count of the points
    const totalPoints = padded.reduce(
      (n, x) => n + (x as unknown as { points: Json[] }).points.length,
      0,
    );
    return ok(
      stringifyJsonDecimal({
        model: model.slug,
        granularity,
        point_schema: [...(schema ?? []), ...padSchema],
        series: padded,
        totalPoints: new Num(String(totalPoints)),
      } as Json),
    );
  }
}
