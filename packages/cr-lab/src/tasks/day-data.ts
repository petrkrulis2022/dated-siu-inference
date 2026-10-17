/**
 * A day's snapshots as typed data, for the instance generators and the reference solvers. It reads what the daily plan stored (it never calls Blockworks) and parses every
 * response with `parseJsonDecimal`, so each figure is a decimal built from the source text. A dataset whose snapshots are missing (a step that failed) is simply empty, and is
 * listed in `missing`; the generators then offer fewer or no instances of that task rather than guess.
 *
 * A null in a series is kept as null, never read as zero: a venue that had no volume reported for a day contributes nothing to that day, and says so.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import { Num, parseJsonDecimal, type Json } from "../data-desk/json-decimal.js";
import type { SnapshotStore } from "../data-desk/snapshots.js";

type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Num)
    ? (v as Obj)
    : undefined;
const arr = (v: Json | undefined): Json[] => (Array.isArray(v) ? v : []);
const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const dec = (v: Json | undefined): DecimalValue | null => (v instanceof Num ? v.toDecimal() : null);
const dayOf = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export interface LendingDay {
  fees: DecimalValue | null;
  revenue: DecimalValue | null;
  interest: DecimalValue | null;
  nii: DecimalValue | null;
}
export interface UnlockSchedule {
  genesis: string;
  projectedEnd: string;
  /** one entry per daily snapshot, in order, the first being the snapshot day */
  days: { day: string; native: DecimalValue }[];
}
export interface Bounds {
  first: { day: string; usd: DecimalValue | null };
  last: { day: string; usd: DecimalValue | null };
}

export interface DayData {
  window: string;
  perpVenues: string[];
  /** venue -> date -> volume in USD, null where the source holds no figure */
  perp: Map<string, Map<string, DecimalValue | null>>;
  lendingProtocols: string[];
  lending: Map<string, Map<string, LendingDay>>;
  /** slug -> id for every token in the unlock list */
  tokenIds: Map<string, string>;
  schedules: Map<string, UnlockSchedule>;
  /** asset id -> date -> circulating supply */
  supply: Map<string, Map<string, DecimalValue | null>>;
  stablecoins: { chain: Map<string, Bounds>; issuer: Map<string, Bounds> };
  /** the datasets for which this day has no snapshot at all */
  missing: string[];
}

/** The path and parameters of a stored canonical query, `GET <api> <path>?<params>`. */
export function parseCanonical(text: string): {
  api: string;
  path: string;
  params: Record<string, string>;
} {
  const m = /^GET (\S+) ([^?\s]+)(?:\?(\S*))?$/.exec(text);
  if (m === null) throw new Error(`not a canonical query: ${text.slice(0, 60)}`);
  const params: Record<string, string> = {};
  for (const kv of (m[3] ?? "").split("&").filter((x) => x !== ""))
    params[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  return { api: m[1] as string, path: m[2] as string, params };
}

/** The series of a timeseries response: its fields after time, and for each series key the points as `[day, values...]`. */
export function readTimeseries(json: Json): {
  fields: string[];
  series: Map<string, { t: number; v: (DecimalValue | null)[] }[]>;
} {
  const data = obj(obj(json)?.data);
  const fields = arr(data?.point_schema)
    .map((e) => str(obj(e)?.field) ?? "?")
    .slice(1);
  const series = new Map<string, { t: number; v: (DecimalValue | null)[] }[]>();
  for (const s of arr(data?.series)) {
    const key = str(obj(s)?.key);
    if (key === undefined) continue;
    series.set(
      key,
      arr(obj(s)?.points).map((p) => {
        const cells = arr(p);
        return {
          t: Number((cells[0] as Num | undefined)?.text ?? "NaN"),
          v: cells.slice(1).map(dec),
        };
      }),
    );
  }
  return { fields, series };
}

export function loadDay(store: SnapshotStore, window: string, tag = "daily"): DayData {
  const day: DayData = {
    window,
    perpVenues: [],
    perp: new Map(),
    lendingProtocols: [],
    lending: new Map(),
    tokenIds: new Map(),
    schedules: new Map(),
    supply: new Map(),
    stablecoins: { chain: new Map(), issuer: new Map() },
    missing: [],
  };
  const seen = new Set<string>();

  for (const { meta, body } of store.list(window, tag)) {
    const q = parseCanonical(meta.query);
    const json = parseJsonDecimal(new TextDecoder().decode(body));
    const p = q.path;
    if (p === "/query/tabular/perp-dex-protocols") {
      seen.add("perp");
      day.perpVenues = arr(obj(json)?.data)
        .map((r) => str(obj(r)?.id))
        .filter((x): x is string => x !== undefined);
    } else if (p.startsWith("/query/timeseries/perp-dex-protocols/")) {
      seen.add("perp");
      const { fields, series } = readTimeseries(json);
      const c = fields.indexOf("volumeUSD");
      for (const [key, pts] of series) {
        const m = day.perp.get(key) ?? new Map<string, DecimalValue | null>();
        for (const pt of pts) m.set(dayOf(pt.t), c < 0 ? null : (pt.v[c] ?? null));
        day.perp.set(key, m);
      }
    } else if (p === "/query/tabular/lending-protocols") {
      seen.add("lending");
      day.lendingProtocols = arr(obj(json)?.data)
        .map((r) => str(obj(r)?.id))
        .filter((x): x is string => x !== undefined);
    } else if (p.startsWith("/query/timeseries/lending-protocols/")) {
      seen.add("lending");
      const { fields, series } = readTimeseries(json);
      const idx = {
        fees: fields.indexOf("fees-usd"),
        revenue: fields.indexOf("revenue-usd"),
        interest: fields.indexOf("interest-usd"),
        nii: fields.indexOf("net-interest-income-usd"),
      };
      for (const [key, pts] of series) {
        const m = day.lending.get(key) ?? new Map<string, LendingDay>();
        for (const pt of pts) {
          const at = (i: number) => (i < 0 ? null : (pt.v[i] ?? null));
          m.set(dayOf(pt.t), {
            fees: at(idx.fees),
            revenue: at(idx.revenue),
            interest: at(idx.interest),
            nii: at(idx.nii),
          });
        }
        day.lending.set(key, m);
      }
    } else if (p === "/token-unlocks/v1/assets") {
      seen.add("tokens");
      for (const r of arr(obj(json)?.data)) {
        const slug = str(obj(r)?.slug);
        const id = str(obj(r)?.id);
        if (slug !== undefined && id !== undefined) day.tokenIds.set(slug, id);
      }
    } else if (/^\/token-unlocks\/v1\/assets\/[^/]+\/unlocks$/.test(p)) {
      seen.add("tokens");
      const slug = p.split("/")[4] as string;
      const data = obj(obj(json)?.data);
      const days = arr(data?.totalSnapshots).map((x) => ({
        day: (str(obj(x)?.timestamp) ?? "").slice(0, 10),
        native: dec(obj(x)?.unlockedInPeriodNative) ?? new D(0),
      }));
      day.schedules.set(slug, {
        genesis: (str(data?.genesisDate) ?? "").slice(0, 10),
        projectedEnd: (str(data?.projectedEndDate) ?? "").slice(0, 10),
        days,
      });
    } else if (p.startsWith("/query/timeseries/asset-supply/")) {
      seen.add("tokens");
      const { fields, series } = readTimeseries(json);
      const c = fields.indexOf("circulating-supply");
      for (const [key, pts] of series) {
        const m = day.supply.get(key) ?? new Map<string, DecimalValue | null>();
        for (const pt of pts) m.set(dayOf(pt.t), c < 0 ? null : (pt.v[c] ?? null));
        day.supply.set(key, m);
      }
    } else if (
      p.startsWith("/query/timeseries/stablecoins-by-chain/") ||
      p.startsWith("/query/timeseries/stablecoins-by-issuer/")
    ) {
      const dim = p.includes("by-chain") ? "chain" : "issuer";
      seen.add("stablecoins");
      const { fields, series } = readTimeseries(json);
      const c = fields.indexOf("circulatingSupplyUSD");
      for (const [key, pts] of series) {
        if (pts.length < 2 || c < 0) continue;
        const first = pts[0] as (typeof pts)[number];
        const last = pts[pts.length - 1] as (typeof pts)[number];
        day.stablecoins[dim].set(key, {
          first: { day: dayOf(first.t), usd: first.v[c] ?? null },
          last: { day: dayOf(last.t), usd: last.v[c] ?? null },
        });
      }
    }
  }
  for (const d of ["perp", "lending", "tokens", "stablecoins"])
    if (!seen.has(d)) day.missing.push(d);
  return day;
}
