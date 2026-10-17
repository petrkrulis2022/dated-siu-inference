/**
 * Day-1 calibration against the LIVE Blockworks API (read-only; no model is called and nothing is spent). It pulls one query from each dataset family through the real desk
 * (stored privately under the `calibration` tag, the committed manifest holds hashes only), prints each response's SHAPE (never a value: see `shape.ts`), and settles the
 * assumptions in `ASSUMED_SHAPES` with derived facts only: true or false, and counts. The same text is written to `data/private/blockworks/calibration/<date>.txt`.
 * `pnpm --filter @touchstone/cr-lab run calibrate`
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { D } from "@touchstone/sdk";
import { privatePath } from "../paths.js";
import {
  addDays,
  completeMonthsWindow,
  daysBetween,
  quarterWindow,
  unixAt,
} from "../data-desk/dates.js";
import { DataDesk, DataDeskError, type Snapshot } from "../data-desk/desk.js";
import { liveBackendFromEnv } from "../data-desk/live.js";
import { Num, type Json } from "../data-desk/json-decimal.js";
import { catalog } from "../data-desk/queries.js";
import { describeShape } from "../data-desk/shape.js";
import { SnapshotStore, defaultStoreOptions } from "../data-desk/snapshots.js";

const today = new Date().toISOString().slice(0, 10);
const out: string[] = [];
const say = (line = "") => {
  out.push(line);
  console.log(line);
};
const TAG = "calibration";
const desk = new DataDesk({
  backend: liveBackendFromEnv(),
  store: new SnapshotStore(defaultStoreOptions("live")),
});

type Obj = { [k: string]: Json };
const obj = (v: Json | undefined): Obj | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Num)
    ? (v as Obj)
    : undefined;
const arr = (v: Json | undefined): Json[] | undefined => (Array.isArray(v) ? v : undefined);
const str = (v: Json | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const dec = (v: Json | undefined): InstanceType<typeof D> | undefined =>
  v instanceof Num ? v.toDecimal() : undefined;
const ts = (v: Json | undefined): number | undefined =>
  v instanceof Num ? Number(v.text) : undefined;

async function pull(
  title: string,
  q: Parameters<DataDesk["pull"]>[0],
): Promise<Snapshot | undefined> {
  say(`\n== ${title}`);
  try {
    const s = await desk.pull(q, { window: today, tag: TAG });
    say(
      `   ${s.bytes} bytes, sha256 ${s.bodySha256.slice(0, 12)}…${s.fromStore ? " (from the store)" : ""}`,
    );
    for (const l of describeShape(s.json)) say(`   ${l}`);
    return s;
  } catch (err) {
    say(
      `   FAILED: ${err instanceof DataDeskError ? err.message : err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/** A timeseries response as columns: the fields after time, and each series' points. */
function view(
  s: Snapshot | undefined,
): { fields: string[]; series: { key: string; points: Json[][] }[] } | undefined {
  const data = obj(obj(s?.json)?.data);
  const schema = arr(data?.point_schema);
  const series = arr(data?.series);
  if (schema === undefined || series === undefined) return undefined;
  return {
    fields: schema.map((e) => str(obj(e)?.field) ?? "?"),
    series: series.map((x) => ({
      key: str(obj(x)?.key) ?? "?",
      points: (arr(obj(x)?.points) ?? []) as Json[][],
    })),
  };
}
const col = (v: NonNullable<ReturnType<typeof view>>, field: string): number =>
  v.fields.indexOf(field);
const rowsOf = (s: Snapshot | undefined): Obj[] =>
  (arr(obj(s?.json)?.data) ?? []).map((r) => obj(r)).filter((r): r is Obj => r !== undefined);

const month = completeMonthsWindow(today, 1);
const quarter = (() => {
  const y = Number(today.slice(0, 4));
  const q = Math.ceil(Number(today.slice(5, 7)) / 3);
  return quarterWindow(q === 1 ? y - 1 : y, q === 1 ? 4 : q - 1);
})();

say(`Blockworks day-1 calibration, ${today} (structure and derived facts only; no values)`);

// ---- CR-VS: perp venues ---------------------------------------------------------------------------------------------------------------------------
const venues = await pull("perp venues: /query/tabular/perp-dex-protocols", catalog.perpVenues());
const venueIds = rowsOf(venues)
  .map((r) => str(r.id))
  .filter((x): x is string => x !== undefined);
say(
  `   venues found: ${venueIds.length}; with a null id: ${rowsOf(venues).length - venueIds.length}`,
);
const vol = await pull(
  "perp volume, 2 venues, last complete month",
  catalog.perpVolume(venueIds.slice(0, 2), month.start, month.end),
);
const vv = view(vol);
if (vv !== undefined) {
  const first = vv.series[0]?.points ?? [];
  const last = first[first.length - 1]?.[0];
  say(
    `   first point at start: ${ts(first[0]?.[0]) === unixAt(month.start)}; last point before end (end exclusive): ${(ts(last) ?? 1e12) < unixAt(month.end)}; points ${first.length} of ${daysBetween(month.start, month.end)} days`,
  );
}
const probe = await pull(
  "perp volume fields: volumeUSD vs marketLevelVolumeUSD vs coreVolumeUSD, 1 venue",
  catalog.probeTimeseries(
    "perp-dex-protocols",
    venueIds.slice(0, 1),
    ["volumeUSD", "marketLevelVolumeUSD", "coreVolumeUSD"],
    month.start,
    month.end,
  ),
);
const pv = view(probe);
if (pv !== undefined && pv.series[0] !== undefined) {
  const [iv, im, ic] = [
    col(pv, "volumeUSD"),
    col(pv, "marketLevelVolumeUSD"),
    col(pv, "coreVolumeUSD"),
  ];
  const pts = pv.series[0].points;
  const nulls = (i: number) =>
    i < 0
      ? "no such column"
      : `${pts.filter((p) => !(p[i] instanceof Num)).length} of ${pts.length}`;
  const both = pts.filter((p) => p[iv] instanceof Num && p[im] instanceof Num);
  const equal = both.filter((p) => dec(p[iv])!.eq(dec(p[im])!)).length;
  say(
    `   nulls: volumeUSD ${nulls(iv)}, marketLevelVolumeUSD ${nulls(im)}, coreVolumeUSD ${nulls(ic)}; volumeUSD equals marketLevelVolumeUSD on ${equal} of ${both.length} days where both exist`,
  );
}

// ---- CR-PL: lending protocols -----------------------------------------------------------------------------------------------------------------------
const lending = await pull(
  "lending protocols: /query/tabular/lending-protocols",
  catalog.lendingProtocols(),
);
const lendIds = rowsOf(lending)
  .map((r) => str(r.id))
  .filter((x): x is string => x !== undefined);
say(`   lending protocols found: ${lendIds.length}`);
for (const id of lendIds.slice(0, 2)) {
  const fin = await pull(
    `lending financials, one protocol, last complete quarter (${quarter.start} to ${quarter.end})`,
    catalog.lendingFinancials(id, quarter.start, quarter.end),
  );
  const lv = view(fin);
  const pts = lv?.series[0]?.points ?? [];
  if (lv !== undefined && pts.length > 0) {
    const c = (f: string) => col(lv, f);
    const v = (p: Json[], f: string) => dec(p[c(f)]) ?? new D(0);
    const extras = (p: Json[]) =>
      v(p, "flash-loan-fees-usd").plus(v(p, "liquidation-fees-usd")).plus(v(p, "royalties-usd"));
    const has = ["fees-usd", "revenue-usd", "interest-usd", "net-interest-income-usd"].every(
      (f) => c(f) >= 0,
    );
    say(
      `   requested fields all present in point_schema: ${has}; points ${pts.length} of ${daysBetween(quarter.start, quarter.end)} days`,
    );
    if (has) {
      const n = pts.length;
      // float64 data: an exact equality would fail on rounding noise, so compare to a relative tolerance and report the worst deviation.
      const TOL = new D("0.000000001");
      const rel = (
        a: InstanceType<typeof D>,
        b: InstanceType<typeof D>,
        scale: InstanceType<typeof D>,
      ) => (scale.isZero() ? a.minus(b).abs() : a.minus(b).abs().div(scale));
      const dev = pts.map((p) =>
        rel(
          v(p, "fees-usd").minus(v(p, "revenue-usd")),
          v(p, "interest-usd").minus(v(p, "net-interest-income-usd")),
          v(p, "fees-usd").abs(),
        ),
      );
      say(
        `   identity fees - revenue = interest - net interest income, relative tolerance 1e-9: holds on ${dev.filter((x) => x.lte(TOL)).length} of ${n} days; worst relative deviation ${dev
          .reduce((m, x) => (x.gt(m) ? x : m), new D(0))
          .toSignificantDigits(2)
          .toString()}`,
      );
      say(
        `   payout (interest - net interest income) is never negative: ${pts.every((p) => v(p, "interest-usd").gte(v(p, "net-interest-income-usd").minus("0.000001")))}; revenue never exceeds fees: ${pts.every((p) => v(p, "revenue-usd").lte(v(p, "fees-usd").plus("0.000001")))}`,
      );
      if (c("flash-loan-fees-usd") >= 0) {
        const d2 = pts.map((p) =>
          rel(v(p, "fees-usd"), v(p, "interest-usd").plus(extras(p)), v(p, "fees-usd").abs()),
        );
        say(
          `   fees = interest + flash + liquidation + royalties (null as 0), tolerance 1e-9: holds on ${d2.filter((x) => x.lte(TOL)).length} of ${n} days`,
        );
      }
      const nullsOf = (f: string) =>
        c(f) < 0
          ? "no such column"
          : `${pts.filter((p) => !(p[c(f)] instanceof Num)).length} of ${n}`;
      say(
        `   null days: interest ${nullsOf("interest-usd")}, net interest income ${nullsOf("net-interest-income-usd")}, fees ${nullsOf("fees-usd")}, revenue ${nullsOf("revenue-usd")}`,
      );
    }
  }
}

// ---- CR-UO: token unlocks ---------------------------------------------------------------------------------------------------------------------------
const assets = await pull(
  "token unlock assets: /token-unlocks/v1/assets",
  catalog.tokenUnlockAssets(),
);
const assetRows = (arr(obj(assets?.json)?.data) ?? [])
  .map((r) => obj(r))
  .filter((r): r is Obj => r !== undefined);
say(
  `   data is ${Array.isArray(obj(assets?.json)?.data) ? "an array" : "not an array"}; assets found: ${assetRows.length}; assets with no slug: ${assetRows.filter((r) => str(r.slug) === undefined).length}`,
);

// Search tokens, over their whole event history, for ones with a linear stream: how a rate-change event converts to an amount is the open question (Q10).
const HISTORY_START = "2020-01-01";
const horizon = addDays(today, 91);
const MAX_TRIES = 30;
const found: {
  slug: string;
  evs: { day: string; kind: string; amount: InstanceType<typeof D> }[];
}[] = [];
let tried = 0;
let withEvents = 0;
let emptyObject = 0;
let nullData = 0;
say(
  `\n== searching up to ${MAX_TRIES} tokens (full event history to ${horizon}) for linear streams; shape of the first response with events follows`,
);
let shown = false;
for (const row of assetRows) {
  if (tried >= MAX_TRIES || found.filter((f) => f.evs.some((e) => e.kind === "rate")).length >= 2)
    break;
  const slug = str(row.slug);
  if (slug === undefined) continue;
  tried++;
  let snap: Snapshot | undefined;
  try {
    snap = await desk.pull(catalog.tokenUnlockEvents(slug, HISTORY_START, horizon), {
      window: today,
      tag: TAG,
    });
  } catch (err) {
    say(`   token ${tried}: FAILED ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  const data = obj(snap.json)?.data;
  if (data === null) nullData++;
  const events = arr(obj(data)?.unlockEvents);
  if (events === undefined || events.length === 0) {
    emptyObject++;
    continue;
  }
  withEvents++;
  const kind = (e: Json) =>
    obj(e)?.cliff != null ? "cliff" : obj(e)?.dailyLinearRateChange != null ? "rate" : "none";
  const amt = (e: Json) =>
    dec(obj(obj(e)?.cliff ?? obj(e)?.dailyLinearRateChange)?.amountNative) ?? new D(0);
  const evs = events
    .map((e) => ({
      day: (str(obj(e)?.timestamp) ?? "").slice(0, 10),
      kind: kind(e),
      amount: amt(e),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
  found.push({ slug, evs });
  if (!shown && evs.some((e) => e.kind === "rate")) {
    shown = true;
    say(`   shape of a response that has a rate-change event:`);
    for (const l of describeShape(snap.json)) say(`     ${l}`);
  }
}
const withRate = found.filter((f) => f.evs.some((e) => e.kind === "rate"));
say(
  `   tried ${tried} tokens: ${withEvents} had events, ${emptyObject} had an empty unlockEvents list, ${nullData} answered data: null; ${withRate.length} had at least one dailyLinearRateChange event`,
);
say(
  `   event kinds seen: cliff ${found.reduce((n, f) => n + f.evs.filter((e) => e.kind === "cliff").length, 0)}, rate change ${found.reduce((n, f) => n + f.evs.filter((e) => e.kind === "rate").length, 0)}, neither ${found.reduce((n, f) => n + f.evs.filter((e) => e.kind === "none").length, 0)}`,
);
say(
  `   rate-change amounts seen: positive ${withRate.reduce((n, f) => n + f.evs.filter((e) => e.kind === "rate" && e.amount.gt(0)).length, 0)}, negative ${withRate.reduce((n, f) => n + f.evs.filter((e) => e.kind === "rate" && e.amount.lt(0)).length, 0)}, zero ${withRate.reduce((n, f) => n + f.evs.filter((e) => e.kind === "rate" && e.amount.isZero()).length, 0)}`,
);

for (const f of (withRate.length > 0 ? withRate : found).slice(0, 2)) {
  const sched = await pull(
    "that token's unlock schedule DAILY, today to today + 30 days",
    catalog.tokenUnlockSchedule(f.slug, "DAILY", today, addDays(today, 30)),
  );
  const snaps = arr(obj(obj(sched?.json)?.data)?.totalSnapshots) ?? [];
  say(
    `   schedule snapshots ${snaps.length} for a window of 31 calendar days (today to today + 30): endTime is ${snaps.length === 31 ? "INCLUSIVE" : snaps.length === 30 ? "exclusive" : "unclear"}; includes future periods: ${(str(obj(snaps[snaps.length - 1])?.timestamp) ?? "").slice(0, 10) > today}`,
  );
  const per = snaps.slice(0, 30).map((x) => dec(obj(x)?.unlockedInPeriodNative) ?? new D(0));
  const sched30 = per.reduce((a, b) => a.plus(b), new D(0));
  // Confirmed 2026-10-17: the rate in effect on a day is the `nextDailyAmountNative` of the latest rate-change event on or before it; add the day's cliffs.
  const modelled = per.map((_, i) => {
    const d = addDays(today, i);
    let cliff = new D(0);
    let rate = new D(0);
    for (const e of f.evs) {
      if (e.day > d) continue;
      if (e.kind === "cliff" && e.day === d) cliff = cliff.plus(e.amount);
      if (e.kind === "rate") rate = e.amount;
    }
    return cliff.plus(rate);
  });
  const agree = modelled.filter((x, i) =>
    x
      .minus(per[i] as InstanceType<typeof D>)
      .abs()
      .lte((per[i] as InstanceType<typeof D>).abs().times("0.0001").plus("0.000001")),
  ).length;
  say(
    `   this token: ${f.evs.filter((e) => e.kind === "rate").length} rate-change and ${f.evs.filter((e) => e.kind === "cliff").length} cliff events in history; 30-day schedule total is zero: ${sched30.isZero()}`,
  );
  say(
    `   the rate in effect (next daily amount of the latest rate event) plus that day's cliffs reproduces the schedule on ${agree} of ${per.length} days`,
  );
  const first = f.slug;
  const idSnap = await pull(
    "token id from its slug: /query/tabular/assets/{slug}",
    catalog.assetBySlug(first),
  );
  const idv = str(obj(obj(idSnap?.json)?.data)?.assetID);
  if (idv !== undefined)
    await pull(
      "circulating supply, the last two days",
      catalog.assetSupply(idv, addDays(today, -2), today),
    );
}

// ---- CR-SM: stablecoins ------------------------------------------------------------------------------------------------------------------------------
// Calibration on 2026-10-17 found that `project-tokens` holds only the categories `projects` and `blockchains` (196 rows), so option A (chain x issuer pairs from it) is not available
// with this key. Option B (stablecoins by chain, and by issuer) is checked in a later calibration, once the request limit is known.
say(
  "\n== CR-SM: skipped here. project-tokens holds no stablecoin category with this key (see D94); the by-chain and by-issuer models are calibrated next",
);

say("\n== requests");
for (const r of desk.governor.report())
  say(`   ${r.group}: ${r.requestsToday} requests, ${r.backoffs} back-offs`);
mkdirSync(privatePath("calibration"), { recursive: true });
writeFileSync(privatePath("calibration", `${today}.txt`), `${out.join("\n")}\n`);
