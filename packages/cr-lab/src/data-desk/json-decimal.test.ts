import { describe, expect, it } from "vitest";
import { JsonParseError, Num, numDecimal, numText, parseJsonDecimal } from "./json-decimal.js";

/** Rebuilds a JS value from a parsed one, turning each Num into the JS number JSON.parse would have made. */
function toPlain(v: unknown): unknown {
  if (v instanceof Num) return Number(v.text);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v !== null && typeof v === "object")
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
  return v;
}

describe("parseJsonDecimal keeps number text exact", () => {
  it("preserves digits a JS float would lose", () => {
    const j = parseJsonDecimal(
      '{"a":0.1000000000000000055511151231257827,"b":123456789012345678901234567890,"c":1E+2,"d":-0,"e":9007199254740993}',
    ) as Record<string, Num>;
    expect(j.a?.text).toBe("0.1000000000000000055511151231257827");
    expect(j.b?.text).toBe("123456789012345678901234567890");
    expect(j.c?.text).toBe("1E+2");
    expect(j.d?.text).toBe("-0");
    expect(j.e?.text).toBe("9007199254740993"); // 2^53 + 1: Number() would give ...992
    expect(j.b?.toDecimal().toFixed(0)).toBe("123456789012345678901234567890");
    expect(j.c?.toDecimal().toFixed(0)).toBe("100");
  });

  it("agrees with JSON.parse on everything that is not a number, for many shapes of document", () => {
    let seed = 12345;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    const gen = (depth: number): unknown => {
      const kinds = depth > 3 ? 5 : 7;
      switch (rnd(kinds)) {
        case 0:
          return null;
        case 1:
          return rnd(2) === 0;
        case 2:
          return ["", "a", 'é "\\/\n', "😀 pair", "tab\t"][rnd(5)];
        case 3:
          return rnd(1000) - 500;
        case 4:
          return (rnd(100000) - 50000) / 100;
        case 5:
          return Array.from({ length: rnd(4) }, () => gen(depth + 1));
        default:
          return Object.fromEntries(
            Array.from({ length: rnd(4) }, (_, i) => [
              `k${i}${["", "é", '"q"'][rnd(3)]}`,
              gen(depth + 1),
            ]),
          );
      }
    };
    for (let n = 0; n < 300; n++) {
      const text = JSON.stringify(gen(0), null, rnd(2) === 0 ? 0 : 2);
      expect(toPlain(parseJsonDecimal(text)), text).toEqual(JSON.parse(text));
    }
  });

  it("treats a __proto__ key as an ordinary key, not as the prototype", () => {
    const j = parseJsonDecimal('{"__proto__":{"polluted":true},"x":1}') as Record<string, unknown>;
    expect(Object.keys(j)).toEqual(["__proto__", "x"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("lets a later duplicate key win, as JSON.parse does", () => {
    expect(toPlain(parseJsonDecimal('{"a":1,"a":2}'))).toEqual({ a: 2 });
  });

  it("rejects what is not JSON, with the offset", () => {
    for (const bad of [
      "",
      "{",
      '{"a":}',
      "[1,]",
      "[1 2]",
      '{"a" 1}',
      "01",
      "1.",
      ".5",
      "+1",
      "--1",
      "NaN",
      "Infinity",
      "tru",
      '"abc',
      '"\\u00zz"',
      "[1]x",
      '{"a":1,}',
      "'a'",
    ]) {
      expect(() => parseJsonDecimal(bad), bad).toThrow(JsonParseError);
    }
  });

  it("refuses a control character inside a string and absurd nesting", () => {
    expect(() => parseJsonDecimal('"a\nb"')).toThrow(JsonParseError);
    expect(() => parseJsonDecimal("[".repeat(1000) + "]".repeat(1000))).toThrow(/nesting too deep/);
  });

  it("gives numText and numDecimal for a figure and undefined for a missing one, never a zero", () => {
    const j = parseJsonDecimal('{"v":12.50,"missing":null,"s":"3"}') as Record<string, never>;
    expect(numText(j.v)).toBe("12.50");
    expect(numDecimal(j.v)?.toFixed(2)).toBe("12.50");
    expect(numText(j.missing)).toBeUndefined();
    expect(numDecimal(j.s)).toBeUndefined();
    expect(numDecimal(undefined)).toBeUndefined();
  });

  it("serialises a Num as its text", () => {
    expect(JSON.stringify({ v: new Num("1.50") })).toBe('{"v":"1.50"}');
  });
});

describe("stringifyJsonDecimal", () => {
  it("writes each number as the text it holds, and round-trips through the parser", async () => {
    const { stringifyJsonDecimal } = await import("./json-decimal.js");
    const text = '{"a":[1.50,-0,12345678901234567890,1E+2],"s":"x\\"y","n":null,"t":true,"o":{}}';
    expect(stringifyJsonDecimal(parseJsonDecimal(text))).toBe(text);
  });
  it("refuses a Num that is not a JSON number, and undefined", async () => {
    const { stringifyJsonDecimal } = await import("./json-decimal.js");
    expect(() => stringifyJsonDecimal(new Num("0x10"))).toThrow(TypeError);
    expect(() => stringifyJsonDecimal(new Num("1."))).toThrow(TypeError);
    expect(() => stringifyJsonDecimal(undefined)).toThrow(TypeError);
  });
});
