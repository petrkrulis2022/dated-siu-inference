/**
 * The fixtures backend: answers the catalog's queries from the synthetic `FixtureWorld`, in the response shapes the public docs describe. It enforces the documented limits
 * too (10 series a call, 9,000 points, a window with a start and an end), so a catalog builder that drifts past one fails in tests, not on day 1. Shapes the docs do not state
 * are the ones `ASSUMED_SHAPES` lists.
 */
import { addDays, assertDate, daysBetween, firstOfMonth, monthsBefore } from "../dates.js";
import { Num, stringifyJsonDecimal, type Json } from "../json-decimal.js";
import {
  MAX_POINTS_PER_CALL,
  MAX_SERIES_PER_CALL,
  canonicalQuery,
  queryId,
  validateQuery,
} from "../queries.js";
import type { BackendResponse, DataBackend, Query } from "../types.js";
import {
  FixtureWorld,
  decimalText,
  type Contract,
  type LendingProtocol,
  type PerpVenue,
  type Point,
  type Token,
} from "./world.js";

const enc = new TextEncoder();
const HEADERS = {
  "content-type": "application/json",
  "cache-control": "max-age=1800",
  "cache-status": "fixture",
} as const;

const respond = (status: number, json: Json): BackendResponse => ({
  status,
  body: enc.encode(stringifyJsonDecimal(json)),
  headers: { ...HEADERS, "x-request-id": `fixture-${status}` },
});
const fail = (status: number, message: string): BackendResponse =>
  respond(status, { error: message, data: null });
const num = (v: string | null): Json => (v === null ? null : new Num(v));

interface Row {
  [k: string]: Json;
}

export class FixtureBackend implements DataBackend {
  readonly name = "fixtures" as const;
  /** Every query received, in order: tests read this to check what was asked and how often. */
  readonly requests: Query[] = [];
  readonly world: FixtureWorld;
  readonly #faults: Readonly<Record<string, number>>;

  /** `faults` maps a query's id (`queryId`) to an HTTP status to answer with instead, to test how callers handle a failure. */
  constructor(opts: { world?: FixtureWorld; faults?: Record<string, number> } = {}) {
    this.world = opts.world ?? new FixtureWorld();
    this.#faults = opts.faults ?? {};
  }

  async specVersions(): Promise<Record<string, string>> {
    return { "data-api": "fixtures-0.1.0", "token-unlocks": "fixtures-1.0.0" };
  }

  async get(query: Query): Promise<BackendResponse> {
    validateQuery(query);
    this.requests.push(query);
    const fault = this.#faults[queryId(query)];
    if (fault !== undefined)
      return fail(fault, `fixture fault: ${canonicalQuery(query).slice(0, 60)}`);
    try {
      return this.#route(query);
    } catch (err) {
      return fail(400, err instanceof Error ? err.message : String(err));
    }
  }

  #route(q: Query): BackendResponse {
    const { path, params } = q;
    const w = this.world;
    let m: RegExpExecArray | null;

    if (q.api === "token-unlocks") {
      if (path === "/token-unlocks/v1/assets") {
        return respond(200, {
          error: null,
          data: w.tokens.map((t, i) => ({
            id: t.assetID,
            serialId: new Num(String(i + 1)),
            symbol: t.symbol,
            name: t.name,
            slug: t.slug,
            genesisDate: "2024-01-01",
            projectedEndDate: "2030-01-01",
            category: "fixture",
            sector: "fixture",
            tags: [],
            otherInfo: null,
          })),
        });
      }
      if ((m = /^\/token-unlocks\/v1\/assets\/([^/]+)\/(events|unlocks)$/.exec(path)) !== null) {
        const tok = w.tokens.find((t) => t.assetID === m![1] || t.slug === m![1]);
        if (tok === undefined) return fail(404, "asset not found");
        return m[2] === "events" ? this.#events(tok, params) : this.#unlocks(tok, params);
      }
      return fail(404, "not found");
    }

    if (path === "/query/tabular/perp-dex-protocols")
      return this.#page(
        w.venues.map((v) => ({ id: v.id, name: v.name, slug: v.slug, projectID: v.projectID })),
        params,
      );
    if (path === "/query/tabular/lending-protocols")
      return this.#page(
        w.lending.map((p) => ({ id: p.id, name: p.name })),
        params,
      );
    if (path === "/query/tabular/project-tokens") {
      return this.#page(
        w.contracts.map((c) => ({
          id: c.id,
          chain: c.chain,
          issuerID: c.issuerID,
          networkID: c.networkID,
          category: c.category,
        })),
        params,
      );
    }
    if ((m = /^\/query\/tabular\/assets\/([^/]+)$/.exec(path)) !== null) {
      const t = w.tokens.find((x) => x.slug === m![1]);
      if (t === undefined) return fail(404, "asset not found");
      // A single row comes back as an object, with `metadata.matchedField` saying which column matched (seen on the live API, 2026-10-17).
      return respond(200, {
        error: null,
        data: { assetID: t.assetID, name: t.name, symbol: t.symbol },
        metadata: { matchedField: "slug" },
      });
    }
    if ((m = /^\/query\/timeseries\/([^/]+)\/1d$/.exec(path)) !== null)
      return this.#timeseries(m[1] as string, params);
    return fail(404, "not found");
  }

  /** A tabular response: the filter `categoryEq`, `page` and `pageSize`, and the two metadata fields the docs state. */
  #page(rows: Row[], params: Readonly<Record<string, string>>): BackendResponse {
    const pageSize = Number(params.pageSize ?? "100");
    const page = Number(params.page ?? "1");
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)
      return fail(400, "pageSize must be 1 to 1000");
    if (!Number.isInteger(page) || page < 1) return fail(400, "page must be a positive integer");
    for (const k of Object.keys(params))
      if (k.endsWith("Eq") && k !== "categoryEq") return fail(400, `unknown filter ${k}`);
    const filtered =
      params.categoryEq === undefined ? rows : rows.filter((r) => r.category === params.categoryEq);
    const slice = filtered.slice((page - 1) * pageSize, page * pageSize);
    return respond(200, {
      error: null,
      data: slice,
      metadata: {
        totalRows: new Num(String(filtered.length)),
        totalPages: new Num(String(Math.ceil(filtered.length / pageSize))),
      },
    });
  }

  #timeseries(model: string, params: Readonly<Record<string, string>>): BackendResponse {
    const w = this.world;
    const series = (params.series ?? "").split(",").filter((s) => s !== "");
    if (series.length === 0) return fail(400, "this fixture requires named series");
    if (series.length > MAX_SERIES_PER_CALL)
      return fail(400, `at most ${MAX_SERIES_PER_CALL} series per call`);
    if (params.start === undefined || params.end === undefined)
      return fail(400, "this fixture requires start and end");
    assertDate(params.start, "start");
    assertDate(params.end, "end");
    const days = daysBetween(params.start, params.end);
    if (days <= 0) return fail(400, "end must be after start");
    if (params.bounds !== "true" && days * series.length > MAX_POINTS_PER_CALL)
      return fail(400, `${days * series.length} points is over the ${MAX_POINTS_PER_CALL} limit`);

    type Source = { key: string; name: string; point: (day: string) => Point | undefined };
    let fields: readonly string[];
    let lookup: (key: string) => Source | undefined;
    if (model === "perp-dex-protocols") {
      fields = ["volumeUSD"];
      lookup = (k) =>
        w.venues
          .filter((v: PerpVenue) => v.id === k)
          .map((v) => ({ key: v.id, name: v.name, point: (d: string) => w.perpPoint(v, d) }))[0];
    } else if (model === "lending-protocols") {
      fields = [
        "interest-usd",
        "net-interest-income-usd",
        "flash-loan-fees-usd",
        "liquidation-fees-usd",
        "royalties-usd",
        "fees-usd",
        "revenue-usd",
      ];
      lookup = (k) =>
        w.lending
          .filter((p: LendingProtocol) => p.id === k)
          .map((p) => ({ key: p.id, name: p.name, point: (d: string) => w.lendingPoint(p, d) }))[0];
    } else if (model === "asset-supply") {
      fields = ["circulating-supply", "total-supply"];
      lookup = (k) =>
        w.tokens
          .filter((t: Token) => t.assetID === k)
          .map((t) => ({
            key: t.assetID,
            name: t.name,
            point: (d: string) => w.supplyPoint(t, d),
          }))[0];
    } else if (model === "project-tokens") {
      fields = ["supplyTotal", "supplyIssued", "priceUSD"];
      lookup = (k) =>
        w.contracts
          .filter((c: Contract) => c.id === k)
          .map((c) => ({ key: c.id, name: c.id, point: (d: string) => w.contractPoint(c, d) }))[0];
    } else return fail(404, `unknown model ${model}`);

    const selections = (params.selections ?? fields.join(",")).split(",");
    for (const f of selections)
      if (!fields.includes(f)) return fail(400, `unknown field ${f} for ${model}`);

    const schema: Json[] = [
      {
        name: "Time",
        field: "time",
        description: "Unix timestamp in seconds (UTC)",
        type: "time",
        time: true,
      },
      ...selections.map((f) => ({
        name: f,
        field: f,
        description: `fixture ${f}`,
        type: "float64",
      })),
    ];
    const out: Json[] = series.map((key) => {
      const src = lookup(key);
      let points: Point[] = [];
      if (src !== undefined) {
        for (
          let d = params.start as string;
          daysBetween(d, params.end as string) > 0;
          d = addDays(d, 1)
        ) {
          const p = src.point(d);
          if (p !== undefined) points.push(p);
        }
        if (params.bounds === "true" && points.length > 2)
          points = [points[0] as Point, points[points.length - 1] as Point];
      }
      return {
        key,
        entity: src === undefined ? null : { name: src.name, slug: src.key },
        points: points.map((p) => [
          new Num(String(p.t)),
          ...selections.map((f) => num(p.v[f] ?? null)),
        ]),
      };
    });
    return respond(200, { error: null, data: { point_schema: schema, series: out } });
  }

  #tranche(tok: Token, amount: bigint, recipient: string): Json {
    const total = this.world.totalAllocation(tok);
    const abs = amount < 0n ? -amount : amount;
    const usd = (amount * tok.priceMicroUsd) / 1_000_000n;
    const pct = (abs * 100_000_000n) / total;
    return {
      amountNative: new Num(decimalText(amount, 6)),
      amountUSD: new Num(decimalText(usd, 6)),
      percentOfTotalAllocation: new Num(decimalText(pct, 8)),
      allocations: [
        {
          allocationRecipient: recipient,
          amountNative: new Num(decimalText(amount, 6)),
          amountUSD: new Num(decimalText(usd, 6)),
          percentOfTotalAllocation: new Num(decimalText(pct, 8)),
        },
      ],
    };
  }

  #asset(tok: Token): Json {
    return { id: tok.assetID, name: tok.name, slug: tok.slug, symbol: tok.symbol };
  }

  /** The aggregate linear rate changing on `day`: the rate before and after, and the streams involved, in the live API's field names. */
  #rateChange(tok: Token, day: string): Json {
    const before = this.world.rateOn(tok, addDays(day, -1));
    const after = this.world.rateOn(tok, day);
    const total = this.world.totalAllocation(tok);
    const usd = (a: bigint) => decimalText((a * tok.priceMicroUsd) / 1_000_000n, 6);
    const pct = (a: bigint) => decimalText((a * 100_000_000n) / total, 8);
    const involved = tok.streams.filter((s) => s.start === day || s.end === day);
    return {
      dailyAmountNative: new Num(decimalText(before, 6)),
      dailyAmountUSD: new Num(usd(before)),
      nextDailyAmountNative: new Num(decimalText(after, 6)),
      nextDailyAmountUSD: new Num(usd(after)),
      percentOfTotalAllocation: new Num(pct(before)),
      nextPercentOfTotalAllocation: new Num(pct(after)),
      percentChangeOfRate:
        before === 0n ? null : new Num(decimalText(((after - before) * 100_000_000n) / before, 8)),
      allocations: involved.map((s) => {
        const sb = this.world.rateOn({ ...tok, streams: [s] }, addDays(day, -1));
        const sa = this.world.rateOn({ ...tok, streams: [s] }, day);
        return {
          allocationRecipient: s.recipient,
          dailyAmountNative: new Num(decimalText(sb, 6)),
          nextDailyAmountNative: new Num(decimalText(sa, 6)),
          percentChangeOfRate:
            sb === 0n ? null : new Num(decimalText(((sa - sb) * 100_000_000n) / sb, 8)),
        };
      }),
    };
  }

  #events(tok: Token, params: Readonly<Record<string, string>>): BackendResponse {
    const start = (params.startTime ?? "").slice(0, 10);
    const end = (params.endTime ?? "").slice(0, 10);
    if (daysBetween(assertDate(start, "startTime"), assertDate(end, "endTime")) <= 0)
      return fail(400, "endTime must be after startTime");
    const inWin = (day: string) => daysBetween(start, day) >= 0 && daysBetween(day, end) > 0;
    const events: { day: string; json: Json }[] = [];
    for (const c of tok.cliffs)
      if (inWin(c.day))
        events.push({
          day: c.day,
          json: {
            timestamp: `${c.day}T00:00:00Z`,
            cliff: this.#tranche(tok, c.amount, c.recipient),
            dailyLinearRateChange: null,
          },
        });
    // one event on each day the aggregate linear rate changes (a stream starting or ending)
    const boundaries = [...new Set(tok.streams.flatMap((s) => [s.start, s.end]))].filter(inWin);
    for (const day of boundaries)
      events.push({
        day,
        json: {
          timestamp: `${day}T00:00:00Z`,
          cliff: null,
          dailyLinearRateChange: this.#rateChange(tok, day),
        },
      });
    events.sort((a, b) => a.day.localeCompare(b.day));
    // An empty window is an empty list inside a data object, as the live API answers (not `data: null`).
    return respond(200, {
      error: null,
      data: { asset: this.#asset(tok), unlockEvents: events.map((e) => e.json) },
    });
  }

  #unlocks(tok: Token, params: Readonly<Record<string, string>>): BackendResponse {
    const interval = params.interval;
    if (interval !== "DAILY" && interval !== "WEEKLY" && interval !== "MONTHLY")
      return fail(400, "interval is required: DAILY, WEEKLY or MONTHLY");
    const start = (params.startTime ?? "").slice(0, 10);
    const end = (params.endTime ?? "").slice(0, 10);
    if (daysBetween(assertDate(start, "startTime"), assertDate(end, "endTime")) < 0)
      return fail(400, "endTime must not be before startTime");
    const { genesis, projectedEnd } = this.world.span(tok);
    if (daysBetween(genesis, start) < 0 || daysBetween(start, projectedEnd) < 0) {
      return fail(
        400,
        `start time cannot be before genesis date [${genesis}T00:00:00Z] or after the projected end date [${projectedEnd}T00:00:00Z]`,
      );
    }
    // The end day is INCLUDED: a window from the 17th to the 47th has 31 daily snapshots (seen on the live API, 2026-10-17).
    const last = addDays(end, 1);
    const snaps: Json[] = [];
    for (let p = start; daysBetween(p, last) > 0;) {
      const next =
        interval === "DAILY"
          ? addDays(p, 1)
          : interval === "WEEKLY"
            ? addDays(p, 7)
            : monthsBefore(firstOfMonth(p), -1);
      const stop = daysBetween(next, last) < 0 ? last : next;
      let native = 0n;
      for (let d = p; daysBetween(d, stop) > 0; d = addDays(d, 1))
        native += this.world.unlockedOn(tok, d);
      snaps.push({
        timestamp: `${p}T00:00:00Z`,
        unlockedInPeriodUSD: new Num(decimalText((native * tok.priceMicroUsd) / 1_000_000n, 6)),
        unlockedInPeriodNative: new Num(decimalText(native, 6)),
      });
      p = stop;
    }
    const recipients = [
      ...new Set([...tok.cliffs.map((c) => c.recipient), ...tok.streams.map((x) => x.recipient)]),
    ];
    return respond(200, {
      error: null,
      data: {
        asset: this.#asset(tok),
        genesisDate: `${genesis}T00:00:00Z`,
        projectedEndDate: `${projectedEnd}T00:00:00Z`,
        startDate: `${start}T00:00:00Z`,
        endDate: `${end}T00:00:00Z`,
        interval,
        totalSnapshots: snaps,
        allocations: recipients.map((r) => ({ allocationRecipient: r, dailySnapshots: [] })),
      },
    });
  }
}
