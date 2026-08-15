import { describe, expect, it } from "vitest";
import { publicKeyFor } from "../crypto/sign.js";
import { buildQuoteBody } from "./build.js";
import { signQuote } from "./sign.js";
import { Erc8004Resolver, StaticResolver, verifyQuoteFromIdentity } from "./identity.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const SELLER_ID = "erc8004:0xSellerAddress";

const quote = signQuote(
  buildQuoteBody({
    siu: "1.400",
    pattern: "fixed",
    model: "registry-id",
    rateUsdPerSiu: "0.0483",
    indexVersion: "SIU-2026a",
    printId: "2026-08-14",
    printHash: "0xabc123",
    sellerId: SELLER_ID,
    chain: "base",
    expiresInSeconds: 300,
  }),
  TEST_KEY,
);

describe("StaticResolver", () => {
  it("resolves a known seller_id to its allow-listed public key", () => {
    const resolver = new StaticResolver({ [SELLER_ID]: publicKeyFor(TEST_KEY) });
    expect(resolver.resolve(SELLER_ID)).toEqual({
      publicKey: publicKeyFor(TEST_KEY),
      source: "static-allowlist",
    });
  });

  it("returns null for a seller_id it has no entry for, rather than guessing", () => {
    const resolver = new StaticResolver({});
    expect(resolver.resolve(SELLER_ID)).toBeNull();
  });
});

describe("Erc8004Resolver", () => {
  it("throws — real ERC-8004 resolution is not implemented in build 1", () => {
    const resolver = new Erc8004Resolver();
    expect(() => resolver.resolve()).toThrow(/not implemented/);
  });
});

describe("verifyQuoteFromIdentity", () => {
  it("composes resolution and signature verification into a single valid result", async () => {
    const resolver = new StaticResolver({ [SELLER_ID]: publicKeyFor(TEST_KEY) });
    const result = await verifyQuoteFromIdentity(quote, resolver);
    expect(result.valid).toBe(true);
    expect(result.resolved?.source).toBe("static-allowlist");
  });

  it("fails closed when no identity resolves, without attempting signature verification", async () => {
    const resolver = new StaticResolver({});
    const result = await verifyQuoteFromIdentity(quote, resolver);
    expect(result.valid).toBe(false);
    expect(result.resolved).toBeNull();
    expect(result.reason).toMatch(/no identity resolved/);
  });

  it("fails when the resolved key does not match the quote's actual signer", async () => {
    const wrongKey = `0x${"22".repeat(32)}`;
    const resolver = new StaticResolver({ [SELLER_ID]: publicKeyFor(wrongKey) });
    const result = await verifyQuoteFromIdentity(quote, resolver);
    expect(result.valid).toBe(false);
  });
});
