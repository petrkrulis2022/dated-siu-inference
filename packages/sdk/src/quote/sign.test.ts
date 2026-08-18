import { describe, expect, it } from "vitest";
import type { TouchstoneQuote } from "../types/generated/datum-quote.schema.js";
import { publicKeyFor } from "../crypto/sign.js";
import { buildQuoteBody } from "./build.js";
import { quoteBodyOf, quoteHashHex, signQuote, verifyQuoteSignature } from "./sign.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

const body = buildQuoteBody({
  siu: "1.400",
  pattern: "fixed",
  model: "registry-id",
  rateUsdPerSiu: "0.0483",
  indexVersion: "SIU-2026a",
  printId: "2026-08-14",
  printHash: "0xabc123",
  sellerId: "erc8004:0xSellerAddress",
  chain: "base",
  expiresInSeconds: 300,
});

describe("signQuote / verifyQuoteSignature", () => {
  it("produces a signature that verifies against its own body", () => {
    const quote = signQuote(body, TEST_KEY);
    const check = verifyQuoteSignature(quote, publicKeyFor(TEST_KEY));
    expect(check.valid).toBe(true);
  });

  it("is deterministic — the same body and key produce the same signature", () => {
    expect(signQuote(body, TEST_KEY).sig).toBe(signQuote(body, TEST_KEY).sig);
  });

  it("DETECTS TAMPERING: a changed amount_usd_max invalidates the signature", () => {
    const quote = signQuote(body, TEST_KEY);
    const tampered = { ...quote, amount_usd_max: "999.0000" } as TouchstoneQuote;
    expect(verifyQuoteSignature(tampered, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const quote = signQuote(body, OTHER_KEY);
    expect(verifyQuoteSignature(quote, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("refuses to sign a body that fails the published schema", () => {
    // estimate with no siu_max fails the schema's if/then requirement.
    const broken = { ...body, pattern: "estimate" as const };
    expect(() => signQuote(broken, TEST_KEY)).toThrow(/Refusing to sign/);
  });
});

describe("quoteBodyOf / quoteHashHex", () => {
  it("strips sig before hashing", () => {
    const quote = signQuote(body, TEST_KEY);
    expect((quoteBodyOf(quote) as Partial<TouchstoneQuote>).sig).toBeUndefined();
  });

  it("gives the same hash before and after signing", () => {
    const quote = signQuote(body, TEST_KEY);
    expect(quoteHashHex(quote)).toBe(quoteHashHex(body));
  });

  it("produces a 32-byte keccak256 digest", () => {
    expect(quoteHashHex(body)).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
