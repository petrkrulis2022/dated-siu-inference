/**
 * Describes the SHAPE of a parsed response, never its contents: key names, types, array lengths, how many nulls, and for numbers only a format class (`int`, `dec(6)`, `exp`).
 * Calibration (day 1) uses it to check what the API really sends against `ASSUMED_SHAPES` without writing any licensed value into a log or a terminal. A string is just `string`
 * (or a format class such as `uuid` or `rfc3339`), never its text; an object key is printed, so use it on responses whose keys are field names, not on maps keyed by data.
 */
import { Num, type Json } from "./json-decimal.js";

interface Shape {
  kinds: Map<string, number>;
  /** for objects: each key and how many objects had it */
  keys?: Map<string, { shape: Shape; seen: number }>;
  /** for arrays: the merged shape of the elements, and the lengths seen */
  items?: Shape;
  lengths?: number[];
  /** for arrays of equal-length arrays: the merged shape at each position */
  positions?: Shape[];
  objects: number;
}

const blank = (): Shape => ({ kinds: new Map(), objects: 0 });
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

function numberClass(text: string): string {
  if (/[eE]/.test(text)) return "exp";
  const dot = text.indexOf(".");
  const sign = text.startsWith("-") ? "neg " : "";
  return dot < 0 ? `${sign}int` : `${sign}dec(${text.length - dot - 1})`;
}
function stringClass(s: string): string {
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return "uuid";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(s)) return "rfc3339";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  return s === "" ? "empty string" : "string";
}

function add(shape: Shape, v: Json | undefined, depth: number): void {
  if (v === undefined) return;
  if (v === null) return void bump(shape.kinds, "null");
  if (typeof v === "boolean") return void bump(shape.kinds, "boolean");
  if (typeof v === "string") return void bump(shape.kinds, stringClass(v));
  if (v instanceof Num) return void bump(shape.kinds, `number:${numberClass(v.text)}`);
  if (depth > 8) return void bump(shape.kinds, "…");
  if (Array.isArray(v)) {
    bump(shape.kinds, "array");
    (shape.lengths ??= []).push(v.length);
    shape.items ??= blank();
    for (const e of v.slice(0, 200)) add(shape.items, e, depth + 1);
    if (v.every((e) => Array.isArray(e) && e.length === (v[0] as Json[]).length) && v.length > 0) {
      const width = (v[0] as Json[]).length;
      shape.positions ??= Array.from({ length: width }, blank);
      if (shape.positions.length === width)
        for (const row of v.slice(0, 400) as Json[][])
          row.forEach((cell, i) => add(shape.positions![i] as Shape, cell, depth + 1));
    }
    return;
  }
  bump(shape.kinds, "object");
  shape.objects++;
  shape.keys ??= new Map();
  for (const [k, x] of Object.entries(v)) {
    const entry = shape.keys.get(k) ?? { shape: blank(), seen: 0 };
    entry.seen++;
    add(entry.shape, x, depth + 1);
    shape.keys.set(k, entry);
  }
}

function kindsText(s: Shape): string {
  return [...s.kinds.entries()].map(([k, n]) => (s.kinds.size > 1 ? `${k}×${n}` : k)).join(" | ");
}

function render(s: Shape, indent: string, lines: string[], label: string): void {
  const kinds = kindsText(s);
  if (s.keys !== undefined && s.objects > 0) {
    lines.push(`${indent}${label}${kinds}`);
    for (const [k, e] of s.keys) {
      const optional = e.seen < s.objects ? ` (in ${e.seen} of ${s.objects})` : "";
      render(e.shape, `${indent}  `, lines, `${k}${optional}: `);
    }
  } else if (s.items !== undefined && s.lengths !== undefined) {
    const lo = Math.min(...s.lengths);
    const hi = Math.max(...s.lengths);
    lines.push(`${indent}${label}${kinds}, length ${lo === hi ? lo : `${lo} to ${hi}`}`);
    if (
      s.positions !== undefined &&
      s.positions.length <= 16 &&
      s.items.kinds.get("array") !== undefined
    ) {
      s.positions.forEach((p, i) => render(p, `${indent}  `, lines, `[${i}] `));
    } else render(s.items, `${indent}  `, lines, "each: ");
  } else lines.push(`${indent}${label}${kinds}`);
}

/** The shape of `value` as indented text lines: structure only, never a string's text or a number's digits (beyond its format class). */
export function describeShape(value: Json): string[] {
  const root = blank();
  add(root, value, 0);
  const lines: string[] = [];
  render(root, "", lines, "");
  return lines;
}
