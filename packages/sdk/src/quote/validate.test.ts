import { describe, expect, it } from "vitest";
import type { DatumQuote } from "../types/generated/datum-quote.schema.js";
import { buildQuoteBody } from "./build.js";
import { signQuote } from "./sign.js";
import { validateQuote } from "./validate.js";

const TEST_KEY = `0x${"11".repeat(32)}`;

const validQuote = signQuote(
  buildQuoteBody({
    siu: "1.000",
    pattern: "estimate",
    siuMax: "1.400",
    model: "registry-id",
    rateUsdPerSiu: "0.0483",
    indexVersion: "SIU-2026a",
    printId: "2026-08-14",
    printHash: "0xabc123",
    sellerId: "erc8004:0xSellerAddress",
    chain: "base",
    expiresInSeconds: 300,
  }),
  TEST_KEY,
);

describe("validateQuote", () => {
  it("accepts a validly built and signed quote", () => {
    expect(validateQuote(validQuote).valid).toBe(true);
  });

  it("passes through an ajv schema failure unchanged (missing required field)", () => {
    const { sig: _sig, ...withoutSig } = validQuote;
    void _sig;
    expect(validateQuote(withoutSig).valid).toBe(false);
  });

  it("rejects an unsupported schema_version major", () => {
    const result = validateQuote({ ...validQuote, schema_version: "2.0" });
    expect(result.valid).toBe(false);
  });

  it("rejects siu_max below the point-estimate siu", () => {
    const result = validateQuote({ ...validQuote, siu_max: "0.500" });
    expect(result.valid).toBe(false);
  });

  it("rejects a negative siu", () => {
    const result = validateQuote({ ...validQuote, siu: "-1.000" });
    expect(result.valid).toBe(false);
  });

  it("rejects an amount_usd_max that disagrees with siu_max × rate_usd_per_siu (anti-deception rule)", () => {
    const result = validateQuote({ ...validQuote, amount_usd_max: "0.0001" });
    expect(result.valid).toBe(false);
  });

  it("rejects more than one settlement entry", () => {
    const result = validateQuote({
      ...validQuote,
      settlement: [...validQuote.settlement, ...validQuote.settlement],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a settlement asset that isn't usdc", () => {
    const result = validateQuote({
      ...validQuote,
      settlement: [{ ...validQuote.settlement[0], asset: "wsiu" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects settlement pointed at an address that doesn't match the known USDC address for that chain", () => {
    const result = validateQuote({
      ...validQuote,
      settlement: [{ ...validQuote.settlement[0], address: `0x${"1".repeat(40)}` }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a settlement amount_max that doesn't match amount_usd_max in minor units", () => {
    const result = validateQuote({
      ...validQuote,
      settlement: [{ ...validQuote.settlement[0], amount_max: "1" }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an unparseable expiry", () => {
    const result = validateQuote({ ...validQuote, expiry: "not-a-date" } as unknown as DatumQuote);
    expect(result.valid).toBe(false);
  });
});

describe("validateQuote — minimum quotable amount", () => {
  // pattern "fixed" with rate_usd_per_siu "1.0000" makes amount_usd_max directly controllable
  // via siu (amount_usd_max = siu, rounded half-up to 4dp), isolating the floor check from the
  // amount_usd_max reconciliation check tested above. amount_usd_max is always a multiple of
  // 0.0001 in this format, so "0.0000" is the only possible below-the-floor value — there is no
  // representable step between it and the floor itself.
  function quoteWithSiu(siu: string) {
    return signQuote(
      buildQuoteBody({
        siu,
        pattern: "fixed",
        model: "registry-id",
        rateUsdPerSiu: "1.0000",
        indexVersion: "SIU-2026a",
        printId: "2026-08-14",
        printHash: "0xabc123",
        sellerId: "erc8004:0xSellerAddress",
        chain: "base",
        expiresInSeconds: 300,
      }),
      TEST_KEY,
    );
  }

  it("rejects a quote just below the floor (rounds to 0.0000, the real live bug)", () => {
    const quote = quoteWithSiu("0.00004");
    expect(quote.amount_usd_max).toBe("0.0000");
    const result = validateQuote(quote);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errors.join(" ")).toMatch(/below the minimum quotable amount/);
    }
  });

  it("accepts a quote exactly at the floor", () => {
    const quote = quoteWithSiu("0.00010");
    expect(quote.amount_usd_max).toBe("0.0001");
    expect(validateQuote(quote).valid).toBe(true);
  });

  it("accepts a quote just above the floor", () => {
    const quote = quoteWithSiu("0.00020");
    expect(quote.amount_usd_max).toBe("0.0002");
    expect(validateQuote(quote).valid).toBe(true);
  });
});
