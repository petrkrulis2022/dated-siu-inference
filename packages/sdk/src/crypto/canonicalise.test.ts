import { describe, expect, it } from "vitest";
import { bodyHashHex, canonicalise, fromHex, toHex } from "./canonicalise.js";

describe("canonicalise", () => {
  it("is stable regardless of key insertion order (RFC 8785 sorts keys)", () => {
    const a = canonicalise({ b: 2, a: 1, c: { z: 26, y: 25 } });
    const z = canonicalise({ c: { y: 25, z: 26 }, a: 1, b: 2 });
    expect(a).toBe(z);
    expect(a).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
  });

  it("throws on a body containing a cycle rather than silently truncating it", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalise(cyclic)).toThrow();
  });

  it("throws on a body that canonicalises to undefined", () => {
    expect(() => canonicalise(undefined)).toThrow(/not canonicalisable/);
  });
});

describe("toHex / fromHex", () => {
  it("round-trips bytes through hex", () => {
    const bytes = new Uint8Array([0, 1, 254, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("accepts hex with or without a 0x prefix", () => {
    expect(fromHex("0xabcd")).toEqual(fromHex("abcd"));
  });

  it("rejects an odd-length hex string", () => {
    expect(() => fromHex("0xabc")).toThrow(/odd length/);
  });
});

describe("bodyHashHex", () => {
  it("produces a 32-byte keccak256 digest", () => {
    expect(bodyHashHex({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same canonical body", () => {
    expect(bodyHashHex({ a: 1, b: 2 })).toBe(bodyHashHex({ b: 2, a: 1 }));
  });
});
