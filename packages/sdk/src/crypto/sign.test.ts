import { describe, expect, it } from "vitest";
import { bodyHash, toHex } from "./canonicalise.js";
import { publicKeyFor, signBodyHash, verifyBodySignature } from "./sign.js";

// A fixed, throwaway test key. Not a real key and never used to sign anything real.
const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

describe("signBodyHash / verifyBodySignature", () => {
  it("produces a signature that verifies against its own body", () => {
    const body = { a: 1 };
    const signature = signBodyHash(bodyHash(body), TEST_KEY);
    expect(verifyBodySignature(body, signature, publicKeyFor(TEST_KEY)).valid).toBe(true);
  });

  it("is deterministic — the same body and key produce the same signature", () => {
    const body = { a: 1 };
    const first = signBodyHash(bodyHash(body), TEST_KEY);
    const second = signBodyHash(bodyHash(body), TEST_KEY);
    expect(first).toBe(second);
  });

  it("DETECTS TAMPERING: a changed body invalidates the signature", () => {
    const signature = signBodyHash(bodyHash({ a: 1 }), TEST_KEY);
    const check = verifyBodySignature({ a: 2 }, signature, publicKeyFor(TEST_KEY));
    expect(check.valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const body = { a: 1 };
    const signature = signBodyHash(bodyHash(body), OTHER_KEY);
    const check = verifyBodySignature(body, signature, publicKeyFor(TEST_KEY));
    expect(check.valid).toBe(false);
  });

  it("reports rather than throws on a malformed signature", () => {
    const check = verifyBodySignature({ a: 1 }, "0xdead", publicKeyFor(TEST_KEY));
    expect(check.valid).toBe(false);
    expect(check.reason).toBeTruthy();
  });
});

describe("toHex / bodyHash sanity", () => {
  it("publicKeyFor is deterministic for a given private key", () => {
    expect(publicKeyFor(TEST_KEY)).toBe(publicKeyFor(TEST_KEY));
    expect(toHex(bodyHash({ a: 1 }))).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
