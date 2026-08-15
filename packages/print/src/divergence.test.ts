import { describe, expect, it } from "vitest";
import {
  canonicalise as sdkCanonicalise,
  toHex as sdkToHex,
  fromHex as sdkFromHex,
} from "@datum/sdk";
import { D as SdkD } from "@datum/sdk";
import {
  canonicalise as printCanonicalise,
  toHex as printToHex,
  fromHex as printFromHex,
} from "./sign/canonicalise.js";
import { D as PrintD } from "./decimal.js";

/**
 * `@datum/sdk`'s crypto/money primitives are a deliberate second copy of these exact
 * primitives, not an import — `@datum/print` depends on `@datum/sdk`, never the reverse, so
 * importing print's copy into sdk would be a cycle (see packages/sdk/src/crypto/canonicalise.ts
 * and packages/sdk/src/money/decimal.ts for the full rationale).
 *
 * A duplicated implementation can silently drift with no test failing anywhere else — this
 * file is that test. If a print body and a datum-quote/receipt body were ever canonicalised or
 * hashed differently by the two packages, a signature produced with one copy could fail to
 * verify against the other, which would be a build1-spec.md §6 correctness bug invisible to
 * either package's own test suite in isolation.
 */
describe("@datum/sdk's canonicalisation primitives stay byte-identical to @datum/print's own", () => {
  it("canonicalise produces the same output for the same input", () => {
    const samples: unknown[] = [
      { b: 2, a: 1, c: { z: 26, y: 25 } },
      { siu: "1.000", pattern: "estimate", nested: [1, 2, { x: "y" }] },
      { empty: {}, arr: [], str: 'hello "world"', n: 0, neg: -1, bool: true, nil: null },
    ];
    for (const sample of samples) {
      expect(sdkCanonicalise(sample)).toBe(printCanonicalise(sample));
    }
  });

  it("toHex/fromHex round-trip the same bytes to the same hex string", () => {
    const bytes = new Uint8Array([0, 1, 16, 255, 128, 7]);
    expect(sdkToHex(bytes)).toBe(printToHex(bytes));
    expect(sdkFromHex("0xdeadbeef")).toEqual(printFromHex("0xdeadbeef"));
  });

  it("the two package-scoped Decimal clones share the same precision and exponent configuration", () => {
    expect(SdkD.precision).toBe(PrintD.precision);
    expect(SdkD.toExpNeg).toBe(PrintD.toExpNeg);
    expect(SdkD.toExpPos).toBe(PrintD.toExpPos);
  });

  it("both clones render the same very-small and very-large numbers without exponential notation", () => {
    const tiny = "0.000000000001";
    const huge = "123456789012345";
    expect(new SdkD(tiny).toString()).toBe(new PrintD(tiny).toString());
    expect(new SdkD(huge).toString()).toBe(new PrintD(huge).toString());
    expect(new SdkD(tiny).toString()).not.toMatch(/e/i);
  });
});
