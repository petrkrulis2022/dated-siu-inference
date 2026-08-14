import { describe, expect, it } from "vitest";
import type { Print } from "@datum/sdk";
import { computePrint } from "../compute/index.js";
import { publishableWorkedExampleInput, workedExampleInput } from "../worked-example.fixture.js";
import { canonicalise, printBodyHashHex, printBodyOf } from "./canonicalise.js";
import {
  loadPublisherKeyFromEnv,
  publicKeyFor,
  signPrintBody,
  verifyPrintSignature,
} from "./sign.js";

// A fixed, throwaway test key. Not a real publisher key and never used to sign anything real.
const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

const { body } = computePrint(publishableWorkedExampleInput());

describe("canonicalise", () => {
  it("is stable regardless of key insertion order (RFC 8785 sorts keys)", () => {
    const a = canonicalise({ b: 2, a: 1, c: { z: 26, y: 25 } });
    const z = canonicalise({ c: { y: 25, z: 26 }, a: 1, b: 2 });
    expect(a).toBe(z);
    expect(a).toBe('{"a":1,"b":2,"c":{"y":25,"z":26}}');
  });

  it("produces no whitespace", () => {
    expect(canonicalise({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
  });

  it("strips signature and public_key from the signed body", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const stripped = printBodyOf(signed) as Record<string, unknown>;
    expect(stripped.signature).toBeUndefined();
    expect(stripped.public_key).toBeUndefined();
    // Signing must not otherwise alter the body.
    expect(canonicalise(stripped)).toBe(canonicalise(body));
  });

  it("gives the same body hash before and after signing", () => {
    const signed = signPrintBody(body, TEST_KEY);
    expect(printBodyHashHex(signed)).toBe(printBodyHashHex(body));
  });

  it("produces a 32-byte keccak256 digest", () => {
    expect(printBodyHashHex(body)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe("signPrintBody / verifyPrintSignature", () => {
  it("produces a signature that verifies against its own body", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const check = verifyPrintSignature(signed);
    expect(check.valid).toBe(true);
  });

  it("writes the matching public key into the print", () => {
    const signed = signPrintBody(body, TEST_KEY);
    expect(signed.public_key).toBe(publicKeyFor(TEST_KEY));
    expect(signed.signature).toMatch(/^0x[0-9a-f]+$/);
  });

  it("is deterministic — the same body and key produce the same signature", () => {
    // RFC 6979 deterministic ECDSA. Two runs of the publisher must not produce two different
    // signatures for one print, or "the signature" is not a stable published artefact.
    expect(signPrintBody(body, TEST_KEY).signature).toBe(signPrintBody(body, TEST_KEY).signature);
  });

  it("DETECTS TAMPERING: a changed Dated SIU invalidates the signature", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const tampered = { ...signed, dated_siu: "0.0999" } as Print;
    expect(verifyPrintSignature(tampered).valid).toBe(false);
  });

  it("DETECTS TAMPERING: a changed exchange-rate row invalidates the signature", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const rows = [...signed.exchange_rate_table];
    rows[0] = { ...rows[0], usd_per_siu: "9.9999" };
    const tampered = { ...signed, exchange_rate_table: rows } as Print;
    expect(verifyPrintSignature(tampered).valid).toBe(false);
  });

  it("DETECTS TAMPERING: swapping in a different public key invalidates the signature", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const tampered = { ...signed, public_key: publicKeyFor(OTHER_KEY) } as Print;
    expect(verifyPrintSignature(tampered).valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const signed = signPrintBody(body, OTHER_KEY);
    const mismatched = { ...signed, public_key: publicKeyFor(TEST_KEY) } as Print;
    expect(verifyPrintSignature(mismatched).valid).toBe(false);
  });

  it("reports rather than throws on a malformed signature", () => {
    const signed = signPrintBody(body, TEST_KEY);
    const check = verifyPrintSignature({ ...signed, signature: "0xdead" } as Print);
    expect(check.valid).toBe(false);
    expect(check.reason).toBeTruthy();
  });

  it("refuses to sign a print that fails the published schema", () => {
    // §6.7 requires a sensitivity block, and the schema enforces minItems: 1. A print
    // computed without variants is a valid intermediate but must never become a signed
    // artefact — a signature over an unpublishable body attests to something no verifier
    // can accept.
    const { body: noSensitivity } = computePrint(workedExampleInput());
    expect(noSensitivity.sensitivity_block).toHaveLength(0);
    expect(() => signPrintBody(noSensitivity, TEST_KEY)).toThrow(/Refusing to sign/);
  });
});

describe("loadPublisherKeyFromEnv", () => {
  it("returns the key when set", () => {
    expect(loadPublisherKeyFromEnv({ DATUM_PUBLISHER_KEY: TEST_KEY })).toBe(TEST_KEY);
  });

  it("throws rather than defaulting when unset — never silently sign with a dummy key", () => {
    expect(() => loadPublisherKeyFromEnv({})).toThrow(/DATUM_PUBLISHER_KEY/);
  });
});
