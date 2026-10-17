/**
 * Answers and gates (§16.6). A model's answer is one JSON object in a fixed shape; the gate compares it with the reference solver's key and says pass or fail, objectively (invariant 6:
 * no judge model). A wrong format counts as wrong: the whole reply must be a single JSON object, optionally inside one fenced block (a deviation that is recorded, not a failure),
 * with exactly the keys the task asks for and figures as plain decimals (a JSON number or a decimal string, no exponent, no units, no thousands separators).
 *
 * Every failure found is reported, with a class the failure taxonomy (B3) counts: format, schema, set, order, value, sum, identity.
 * Tolerances are the brief's (D79): CR-VS and CR-UO within 0.01 percentage points, CR-PL and CR-SM within 0.1% of the reference, compared in decimals and never floats.
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import { Num, parseJsonDecimal, type Json } from "../data-desk/json-decimal.js";
import type { PLReference, SMReference, UOReference, VSReference } from "./solve.js";

export type FailureCode = "format" | "schema" | "set" | "order" | "value" | "sum" | "identity";
export interface Failure {
  code: FailureCode;
  detail: string;
}
export interface Verdict {
  passed: boolean;
  failures: Failure[];
  /** the reply was inside a fenced block: noted, not a failure */
  fenced: boolean;
}

type Obj = { [k: string]: Json };
const MAX_DETAILS = 6;

export type Parsed = { ok: true; value: Obj; fenced: boolean } | { ok: false; failure: Failure };

/** The reply as one JSON object. */
export function parseAnswer(text: string): Parsed {
  let body = text.trim();
  let fenced = false;
  const fence = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```$/.exec(body);
  if (fence !== null) {
    body = (fence[1] as string).trim();
    fenced = true;
  }
  let value: Json;
  try {
    value = parseJsonDecimal(body);
  } catch {
    return {
      ok: false,
      failure: { code: "format", detail: "the reply is not a single JSON object" },
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof Num)
    return {
      ok: false,
      failure: { code: "format", detail: "the reply is JSON but not an object" },
    };
  return { ok: true, value: value as Obj, fenced };
}

const DECIMAL = /^-?\d+(\.\d+)?$/;
/** A plain decimal from a JSON number or a decimal string; undefined for anything else (exponent, units, separators, null, boolean). */
export function readDecimal(v: Json | undefined): DecimalValue | undefined {
  if (v instanceof Num) return DECIMAL.test(v.text) ? v.toDecimal() : undefined;
  if (typeof v === "string") return DECIMAL.test(v) ? new D(v) : undefined;
  return undefined;
}
const isObj = (v: Json | undefined): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Num);
const sameKeys = (o: Obj, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => k in o);

class Collector {
  readonly failures: Failure[] = [];
  readonly #per = new Map<FailureCode, number>();
  add(code: FailureCode, detail: string): void {
    const n = (this.#per.get(code) ?? 0) + 1;
    this.#per.set(code, n);
    if (n <= MAX_DETAILS) this.failures.push({ code, detail });
    else if (n === MAX_DETAILS + 1)
      this.failures.push({ code, detail: "(more of the same, not listed)" });
  }
}
const verdict = (c: Collector, fenced: boolean): Verdict => ({
  passed: c.failures.length === 0,
  failures: c.failures,
  fenced,
});

/** |a - ref| within `tol` of |ref|; a zero reference must be matched exactly. */
export const withinRelative = (a: DecimalValue, ref: DecimalValue, tol: string): boolean =>
  a.minus(ref).abs().lte(ref.abs().times(tol));
/** |a - ref| at most `pp` percentage points. */
export const withinAbsolute = (a: DecimalValue, ref: DecimalValue, pp: string): boolean =>
  a.minus(ref).abs().lte(pp);

// ---- CR-VS ---------------------------------------------------------------------------------------------------------------------------------------
export function gateVS(value: Obj, ref: VSReference, fenced = false): Verdict {
  const c = new Collector();
  if (!sameKeys(value, ["venues", "shares"])) {
    c.add("schema", 'the answer must have exactly the keys "venues" and "shares"');
    return verdict(c, fenced);
  }
  const venues = value.venues;
  const shares = value.shares;
  if (
    !Array.isArray(venues) ||
    venues.length !== 5 ||
    !venues.every((v) => typeof v === "string") ||
    new Set(venues).size !== 5 ||
    !isObj(shares)
  ) {
    c.add("schema", '"venues" must be five distinct strings and "shares" an object keyed by month');
    return verdict(c, fenced);
  }
  const mine = venues as string[];
  const months = Object.keys(shares);
  if (months.length !== ref.months.length || !ref.months.every((m) => m in shares)) {
    c.add(
      "schema",
      `"shares" must have exactly the twelve months ${ref.months[0]} to ${ref.months[ref.months.length - 1]}`,
    );
    return verdict(c, fenced);
  }
  const sameSet = mine.length === ref.venues.length && ref.venues.every((v) => mine.includes(v));
  if (!sameSet) c.add("set", "the five venues are not the five largest by twelve-month volume");
  let schemaOk = true;
  for (const m of ref.months) {
    const row = (shares as Obj)[m];
    if (!isObj(row) || !sameKeys(row, mine)) {
      c.add("schema", `month ${m} must give a share for exactly the five venues listed`);
      schemaOk = false;
      continue;
    }
    let total = new D(0);
    for (const v of mine) {
      const x = readDecimal(row[v]);
      if (x === undefined) {
        c.add("schema", `month ${m}, ${v}: not a plain decimal`);
        schemaOk = false;
        continue;
      }
      total = total.plus(x);
      const r = ref.shares[m]?.[v];
      if (sameSet && r !== undefined && !withinAbsolute(x, new D(r), "0.01"))
        c.add(
          "value",
          `month ${m}, ${v}: share is not within 0.01 percentage points of the reference`,
        );
    }
    if (schemaOk && !total.minus(100).abs().lte("0.01"))
      c.add("sum", `month ${m}: the shares add up to ${total.toFixed(4)}, not 100 (within 0.01)`);
  }
  return verdict(c, fenced);
}

// ---- CR-PL ---------------------------------------------------------------------------------------------------------------------------------------
export function gatePL(value: Obj, ref: PLReference, fenced = false): Verdict {
  const c = new Collector();
  if (!sameKeys(value, ["fees", "payouts", "revenue"])) {
    c.add("schema", 'the answer must have exactly the keys "fees", "payouts" and "revenue"');
    return verdict(c, fenced);
  }
  const [fees, payouts, revenue] = ["fees", "payouts", "revenue"].map((k) => readDecimal(value[k]));
  for (const [k, x] of [
    ["fees", fees],
    ["payouts", payouts],
    ["revenue", revenue],
  ] as const)
    if (x === undefined) c.add("schema", `"${k}" is not a plain decimal`);
  if (fees === undefined || payouts === undefined || revenue === undefined)
    return verdict(c, fenced);
  if (!withinRelative(fees, new D(ref.fees), "0.001"))
    c.add("value", "fees are not within 0.1% of the reference");
  if (!withinRelative(payouts, new D(ref.payouts), "0.001"))
    c.add("value", "payouts are not within 0.1% of the reference");
  // the model's own revenue must be its own fees minus its own payouts, EXACTLY: that is arithmetic, and no tolerance applies
  if (!revenue.eq(fees.minus(payouts)))
    c.add("identity", "revenue is not exactly fees minus payouts, using the answer's own figures");
  if (!withinRelative(revenue, new D(ref.revenue), "0.001"))
    c.add("value", "revenue is not within 0.1% of the reference");
  return verdict(c, fenced);
}

// ---- CR-UO ---------------------------------------------------------------------------------------------------------------------------------------
export function gateUO(value: Obj, ref: UOReference, fenced = false): Verdict {
  const c = new Collector();
  if (!sameKeys(value, ["unlock30_pct", "unlock90_pct"])) {
    c.add("schema", 'the answer must have exactly the keys "unlock30_pct" and "unlock90_pct"');
    return verdict(c, fenced);
  }
  for (const [k, r] of [
    ["unlock30_pct", ref.unlock30Pct],
    ["unlock90_pct", ref.unlock90Pct],
  ] as const) {
    const x = readDecimal(value[k]);
    if (x === undefined) c.add("schema", `"${k}" is not a plain decimal`);
    else if (!withinAbsolute(x, new D(r), "0.01"))
      c.add("value", `"${k}" is not within 0.01 percentage points of the reference`);
  }
  return verdict(c, fenced);
}

// ---- CR-SM ---------------------------------------------------------------------------------------------------------------------------------------
export function gateSM(value: Obj, ref: SMReference, fenced = false): Verdict {
  const c = new Collector();
  if (!sameKeys(value, ["top5"])) {
    c.add("schema", 'the answer must have exactly the key "top5"');
    return verdict(c, fenced);
  }
  const top = value.top5;
  if (
    !Array.isArray(top) ||
    top.length !== 5 ||
    !top.every((r) => isObj(r) && sameKeys(r, ["id", "change_usd"]) && typeof r.id === "string")
  ) {
    c.add("schema", '"top5" must be five objects with exactly "id" (a string) and "change_usd"');
    return verdict(c, fenced);
  }
  const rows = (top as Obj[]).map((r) => ({
    id: r.id as string,
    change: readDecimal(r.change_usd),
  }));
  if (new Set(rows.map((r) => r.id)).size !== 5) c.add("schema", "the five ids must be distinct");
  rows.forEach(
    (r, i) =>
      r.change === undefined &&
      c.add("schema", `entry ${i + 1}: "change_usd" is not a plain decimal`),
  );
  const mine = rows.map((r) => r.id);
  const refIds = ref.top5.map((r) => r.id);
  const sameSet = refIds.every((id) => mine.includes(id)) && mine.length === refIds.length;
  if (!sameSet)
    c.add("set", `the five ${ref.dimension}s are not the five with the largest absolute change`);
  else if (mine.some((id, i) => id !== refIds[i]))
    c.add("order", `the right five ${ref.dimension}s, but not in order of absolute change`);
  if (sameSet) {
    for (const r of rows) {
      const want = ref.top5.find((x) => x.id === r.id);
      if (
        r.change !== undefined &&
        want !== undefined &&
        !withinRelative(r.change, new D(want.changeUsd), "0.001")
      )
        c.add("value", `${r.id}: the change is not within 0.1% of the reference`);
    }
  }
  return verdict(c, fenced);
}
