import { describe, expect, it } from "vitest";
import { describeShape } from "./shape.js";
import { parseJsonDecimal } from "./json-decimal.js";

const shape = (text: string) => describeShape(parseJsonDecimal(text)).join("\n");

describe("describeShape", () => {
  it("describes an envelope: keys, types, array length, and number formats", () => {
    const out = shape(
      '{"error":null,"data":[{"id":"a","v":1.50,"n":3},{"id":"b","v":2.25,"n":4}],"metadata":{"totalRows":2,"totalPages":1}}',
    );
    expect(out).toContain("error: null");
    expect(out).toContain("data: array, length 2");
    expect(out).toContain("id: string");
    expect(out).toContain("v: number:dec(2)");
    expect(out).toContain("n: number:int");
    expect(out).toContain("totalRows: number:int");
  });

  it("never prints a string's text or a number's digits", () => {
    const out = shape(
      '{"name":"SECRET-PROTOCOL-NAME","amount":987654.321,"big":123456789012345678901234567890,"list":["VERY-PRIVATE"],"id":"c0ffee00-1111-4222-8333-444455556666"}',
    );
    for (const leak of ["SECRET", "PROTOCOL", "987654", "321", "123456789", "PRIVATE", "c0ffee"])
      expect(out, leak).not.toContain(leak);
    expect(out).toContain("id: uuid");
    expect(out).toContain("amount: number:dec(3)");
  });

  it("describes timeseries points position by position, with nulls and number formats", () => {
    const out = shape(
      '{"series":[{"key":"k","points":[[1760000000,12.5,null],[1760086400,13.75,2.0]]}]}',
    );
    expect(out).toContain("points: array, length 2");
    expect(out).toContain("[0] number:int");
    expect(out).toContain("[1] number:dec(");
    expect(out).toMatch(/\[2\] .*null/);
  });

  it("marks a key that only some objects have, and mixed types", () => {
    const out = shape('[{"a":1,"b":"x"},{"a":null}]');
    expect(out).toContain("b (in 1 of 2): string");
    expect(out).toMatch(/a: number:int×1 \| null×1/);
  });

  it("classifies exponent and negative numbers, dates and RFC 3339 timestamps without showing them", () => {
    const out = shape('{"e":1E+2,"n":-4.5,"d":"2026-10-20","t":"2026-10-20T00:00:00Z","s":""}');
    expect(out).toContain("e: number:exp");
    expect(out).toContain("n: number:neg dec(1)");
    expect(out).toContain("d: date");
    expect(out).toContain("t: rfc3339");
    expect(out).toContain("s: empty string");
  });

  it("handles scalars, empty containers and deep nesting without failing", () => {
    expect(shape("null")).toBe("null");
    expect(shape("[]")).toContain("array, length 0");
    expect(shape("{}")).toBe("object");
    expect(() => shape("[".repeat(60) + "]".repeat(60))).not.toThrow();
  });
});
