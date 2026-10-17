/**
 * The failure taxonomy (§16.7), automated. The gates already name what failed (`format`, `schema`, `set`, `order`, `value`, `sum`, `identity`); this turns that, and the shape of the
 * reply, into the classes the daily failure report counts. Every failed answer gets one PRIMARY class (the first that applies, in the order of `PRIORITY`) and may carry others.
 *
 *   call-failed     the provider call itself failed (HTTP error, timeout); nothing was graded
 *   truncated       the provider ended the reply at its length limit (the provider's own stop reason, never inferred); ranks above no-output because it is the cause of an empty reply
 *   no-output       the call finished but returned no text
 *   schema          the reply is not the task's JSON object, or has the wrong keys or types
 *   missing-items   the shape is right but items are missing: fewer than five entries, months absent, keys absent
 *   wrong-entity    the wrong venue, token, pair or id set was chosen
 *   ordering        the right items in the wrong order
 *   scale-slip      a figure has the right digits and the wrong power of ten (the stage-1 checker's rule, applied to the answer against the key)
 *   arithmetic      a figure is wrong by something other than a power of ten, or the answer contradicts itself (shares not summing to 100, revenue not fees minus payouts)
 *   unclassified    a failed answer no rule above explains; listed in full for review
 */
import { D, type DecimalValue } from "@touchstone/sdk";
import { Num, type Json } from "../data-desk/json-decimal.js";
import {
  parseAnswer,
  readDecimal,
  withinAbsolute,
  withinRelative,
  type Failure,
  type Verdict,
} from "../tasks/gates.js";
import type { Instance } from "../tasks/instances.js";
import type { PLReference, SMReference, UOReference, VSReference } from "../tasks/solve.js";

export type FailureClass =
  | "call-failed"
  | "no-output"
  | "truncated"
  | "schema"
  | "missing-items"
  | "wrong-entity"
  | "ordering"
  | "scale-slip"
  | "arithmetic"
  | "unclassified";

export const PRIORITY: readonly FailureClass[] = [
  "call-failed",
  "truncated",
  "no-output",
  "schema",
  "missing-items",
  "wrong-entity",
  "ordering",
  "scale-slip",
  "arithmetic",
  "unclassified",
];

type Obj = { [k: string]: Json };
const isObj = (v: Json | undefined): v is Obj =>
  v !== null &&
  v !== undefined &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  !(v instanceof Num);

/**
 * Right digits, wrong power of ten: the ratio of answer to key is 10^k (k not 0, |k| up to 9) within 1%. A zero on either side is never a slip. The tolerance is wider than the
 * gate's on purpose: a figure that is a power of ten off is classed a slip even if its digits are also slightly off.
 */
export function isPowerOfTenSlip(answer: DecimalValue, key: DecimalValue): boolean {
  if (answer.isZero() || key.isZero() || answer.isNegative() !== key.isNegative()) return false;
  const ratio = answer.abs().div(key.abs());
  for (let k = -9; k <= 9; k++) {
    if (k === 0) continue;
    const target = new D(10).pow(k);
    if (ratio.div(target).minus(1).abs().lte("0.01")) return true;
  }
  return false;
}

interface Pair {
  answer: DecimalValue;
  key: DecimalValue;
}

/** The numeric comparisons the task's gate made and the answer FAILED, as (answer, key) pairs; empty if the shape is wrong. */
function failingPairs(instance: Instance, value: Obj): Pair[] {
  const out: Pair[] = [];
  const add = (
    a: Json | undefined,
    key: string,
    ok: (x: DecimalValue, k: DecimalValue) => boolean,
  ) => {
    const x = readDecimal(a);
    if (x === undefined) return;
    const k = new D(key);
    if (!ok(x, k)) out.push({ answer: x, key: k });
  };
  switch (instance.task) {
    case "CR-VS": {
      const ref = instance.reference as VSReference;
      const shares = value.shares;
      if (!isObj(shares)) return out;
      for (const m of ref.months) {
        const row = shares[m];
        if (!isObj(row)) continue;
        for (const [v, key] of Object.entries(ref.shares[m] ?? {}))
          add(row[v], key, (x, k) => withinAbsolute(x, k, "0.01"));
      }
      return out;
    }
    case "CR-PL": {
      const ref = instance.reference as PLReference;
      for (const f of ["fees", "payouts", "revenue"] as const)
        add(value[f], ref[f], (x, k) => withinRelative(x, k, "0.001"));
      return out;
    }
    case "CR-UO": {
      const ref = instance.reference as UOReference;
      add(value.unlock30_pct, ref.unlock30Pct, (x, k) => withinAbsolute(x, k, "0.01"));
      add(value.unlock90_pct, ref.unlock90Pct, (x, k) => withinAbsolute(x, k, "0.01"));
      return out;
    }
    case "CR-SM": {
      const ref = instance.reference as SMReference;
      const top = value.top5;
      if (!Array.isArray(top)) return out;
      for (const r of top) {
        if (!isObj(r) || typeof r.id !== "string") continue;
        const want = ref.top5.find((x) => x.id === r.id);
        if (want !== undefined)
          add(r.change_usd, want.changeUsd, (x, k) => withinRelative(x, k, "0.001"));
      }
      return out;
    }
  }
}

/** Some of the expected keys, and nothing else: the reply is short of items. A reply with keys of other names is a schema failure, not a short one. */
function onlyExpectedKeysButShort(value: Obj, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    keys.every((k) => expected.includes(k)) &&
    expected.some((k) => !(k in value))
  );
}

/** True if the reply has the right kind of shape but is short of items (so "schema" would blame the wrong thing). */
function isMissingItems(instance: Instance, value: Obj): boolean {
  switch (instance.task) {
    case "CR-VS": {
      const ref = instance.reference as VSReference;
      const venues = value.venues;
      const shares = value.shares;
      if (Array.isArray(venues) && venues.length < 5) return true;
      if (isObj(shares) && ref.months.some((m) => !(m in shares))) return true;
      if (isObj(shares))
        for (const m of ref.months) {
          const row = shares[m];
          if (isObj(row) && Object.keys(row).length < 5) return true;
        }
      return false;
    }
    case "CR-PL":
      return onlyExpectedKeysButShort(value, ["fees", "payouts", "revenue"]);
    case "CR-UO":
      return onlyExpectedKeysButShort(value, ["unlock30_pct", "unlock90_pct"]);
    case "CR-SM":
      return Array.isArray(value.top5) && value.top5.length < 5;
  }
}

export interface ClassifyInput {
  instance: Instance;
  /** the provider call failed before any reply: a sanitised reason */
  callError?: string;
  /** the reply text ("" if none) */
  text: string;
  /** the provider's own stop reason, if it gave one */
  stopReason?: string;
  /** the gate's verdict, when the reply was gradeable */
  verdict?: Verdict;
}

export interface Classification {
  /** the primary class; undefined for a passed answer */
  primary?: FailureClass;
  /** every class that applies, in priority order, primary first */
  classes: FailureClass[];
}

const TRUNCATION = new Set(["max_tokens", "length", "MAX_TOKENS", "max_output_tokens"]);

export function classify(input: ClassifyInput): Classification {
  const found = new Set<FailureClass>();
  if (input.callError !== undefined) found.add("call-failed");
  else if (input.text.trim() === "") found.add("no-output");
  if (
    input.stopReason !== undefined &&
    TRUNCATION.has(input.stopReason) &&
    input.verdict?.passed !== true
  )
    found.add("truncated");

  const v = input.verdict;
  if (v !== undefined && !v.passed) {
    const parsed = parseAnswer(input.text);
    const value = parsed.ok ? parsed.value : undefined;
    const codes = new Set(v.failures.map((f: Failure) => f.code));
    if (codes.has("format")) found.add("schema");
    if (codes.has("schema"))
      found.add(
        value !== undefined && isMissingItems(input.instance, value) ? "missing-items" : "schema",
      );
    if (codes.has("set")) found.add("wrong-entity");
    if (codes.has("order")) found.add("ordering");
    if (codes.has("sum") || codes.has("identity")) found.add("arithmetic");
    if (codes.has("value")) {
      const slips =
        value === undefined
          ? []
          : failingPairs(input.instance, value).filter((p) => isPowerOfTenSlip(p.answer, p.key));
      found.add(slips.length > 0 ? "scale-slip" : "arithmetic");
    }
    if (found.size === 0) found.add("unclassified");
  }
  const classes = PRIORITY.filter((c) => found.has(c));
  return classes.length === 0 ? { classes } : { primary: classes[0] as FailureClass, classes };
}
