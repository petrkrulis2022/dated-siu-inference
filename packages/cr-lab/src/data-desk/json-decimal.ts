/**
 * A JSON parser that keeps every number as the text it arrived as.
 *
 * Blockworks sends values as JSON numbers (float64). `JSON.parse` would turn each into a JS float and lose digits on the way, and the trial's rule is decimal
 * strings for every figure that is money or compared to a tolerance (invariant 4). So a snapshot is parsed here: a number becomes a `Num` holding its exact text,
 * and `toDecimal()` gives a decimal from that text. Everything else (strings, booleans, null, arrays, objects) parses as in `JSON.parse`.
 * Objects have no prototype, so a key such as `__proto__` in a response is just a key.
 */
import { D, type DecimalValue } from "@touchstone/sdk";

/** A JSON number, as its source text. */
export class Num {
  constructor(readonly text: string) {}
  toDecimal(): DecimalValue {
    return new D(this.text);
  }
  toString(): string {
    return this.text;
  }
  toJSON(): string {
    return this.text;
  }
}

export type Json = null | boolean | string | Num | Json[] | { [key: string]: Json };

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const MAX_DEPTH = 256;

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = "JsonParseError";
  }
}

export function parseJsonDecimal(text: string): Json {
  let i = 0;

  const ws = () => {
    while (
      i < text.length &&
      (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")
    )
      i++;
  };

  const string = (): string => {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") i += 2;
      else if (c === '"') {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          throw new JsonParseError("invalid string", start);
        }
      } else if (c !== undefined && c.charCodeAt(0) < 0x20)
        throw new JsonParseError("control character in string", i);
      else i++;
    }
    throw new JsonParseError("unterminated string", start);
  };

  const value = (depth: number): Json => {
    if (depth > MAX_DEPTH) throw new JsonParseError("nesting too deep", i);
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const obj: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new JsonParseError("expected a string key", i);
        const key = string();
        ws();
        if (text[i] !== ":") throw new JsonParseError("expected ':'", i);
        i++;
        obj[key] = value(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        throw new JsonParseError("expected ',' or '}'", i);
      }
    }
    if (c === "[") {
      i++;
      const arr: Json[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        throw new JsonParseError("expected ',' or ']'", i);
      }
    }
    if (c === '"') return string();
    if (text.startsWith("true", i)) return ((i += 4), true);
    if (text.startsWith("false", i)) return ((i += 5), false);
    if (text.startsWith("null", i)) return ((i += 4), null);
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (m === null) throw new JsonParseError("unexpected character", i);
    i += m[0].length;
    return new Num(m[0]);
  };

  const result = value(0);
  ws();
  if (i !== text.length) throw new JsonParseError("unexpected trailing content", i);
  return result;
}

/** The text of a JSON number, or undefined for null or a non-number (a missing figure is not a zero). */
export const numText = (v: Json | undefined): string | undefined =>
  v instanceof Num ? v.text : undefined;

/** A decimal from a JSON number; undefined for null or a non-number. */
export const numDecimal = (v: Json | undefined): DecimalValue | undefined =>
  v instanceof Num ? v.toDecimal() : undefined;

/** The reverse of `parseJsonDecimal`: JSON text where each `Num` is written as the number it holds, unquoted and unchanged. Used to build fixture responses. */
export function stringifyJsonDecimal(value: Json | undefined): string {
  if (value === undefined) throw new TypeError("cannot stringify undefined");
  if (value instanceof Num) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value.text))
      throw new TypeError(`not a JSON number: ${value.text}`);
    return value.text;
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stringifyJsonDecimal).join(",")}]`;
  return `{${Object.entries(value)
    .map(([k, v]) => `${JSON.stringify(k)}:${stringifyJsonDecimal(v)}`)
    .join(",")}}`;
}
