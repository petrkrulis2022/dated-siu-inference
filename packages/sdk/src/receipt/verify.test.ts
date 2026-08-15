import { describe, expect, it } from "vitest";
import type { Receipt } from "../types/generated/receipt.schema.js";
import { publicKeyFor } from "../crypto/sign.js";
import { buildQuoteBody, signQuote } from "../quote/index.js";
import { quoteHashHex } from "../quote/sign.js";
import { signReceipt, type ReceiptBody } from "./sign.js";
import { verifyReceipt } from "./verify.js";

const TEST_KEY = `0x${"11".repeat(32)}`;

const quote = signQuote(
  buildQuoteBody({
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
  }),
  TEST_KEY,
);

function receiptBody(overrides: Partial<ReceiptBody> = {}): ReceiptBody {
  return {
    schema_version: "1.0",
    quote_hash: quoteHashHex(quote),
    chain: "base",
    tx_ref: `0x${"b".repeat(64)}`,
    amount_quoted_usd: "0.0676",
    amount_paid_usd: "0.0676",
    matched: true,
    print_ref: "2026-08-14",
    ...overrides,
  };
}

describe("verifyReceipt", () => {
  it("accepts a signed receipt with an honest matched flag and no quote supplied", () => {
    const receipt = signReceipt(receiptBody(), TEST_KEY);
    const result = verifyReceipt(receipt, { publicKeyHex: publicKeyFor(TEST_KEY) });
    expect(result.valid).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("rejects an invalid signature", () => {
    const receipt = signReceipt(receiptBody(), TEST_KEY);
    const tampered = { ...receipt, amount_paid_usd: "0.0001" } as Receipt;
    const result = verifyReceipt(tampered, { publicKeyHex: publicKeyFor(TEST_KEY) });
    expect(result.valid).toBe(false);
  });

  it("REJECTS a dishonest matched flag: paid exceeds quoted but matched claims true", () => {
    // signReceipt only checks schema shape, not this cross-field honesty rule, so this
    // constructs a schema-valid-but-dishonest receipt on purpose.
    const receipt = signReceipt(
      receiptBody({ amount_quoted_usd: "0.0676", amount_paid_usd: "1.0000", matched: true }),
      TEST_KEY,
    );
    const result = verifyReceipt(receipt, { publicKeyHex: publicKeyFor(TEST_KEY) });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("matched"))).toBe(true);
  });

  it("accepts matched: false when the paid amount genuinely exceeds the quoted amount", () => {
    const receipt = signReceipt(
      receiptBody({ amount_quoted_usd: "0.0676", amount_paid_usd: "1.0000", matched: false }),
      TEST_KEY,
    );
    const result = verifyReceipt(receipt, { publicKeyHex: publicKeyFor(TEST_KEY) });
    expect(result.valid).toBe(true);
  });

  it("binds quote_hash to a supplied quote and passes when they match", () => {
    const receipt = signReceipt(receiptBody(), TEST_KEY);
    const result = verifyReceipt(receipt, { publicKeyHex: publicKeyFor(TEST_KEY), quote });
    expect(result.valid).toBe(true);
  });

  it("rejects a receipt whose quote_hash does not match the supplied quote", () => {
    const receipt = signReceipt(receiptBody({ quote_hash: `0x${"9".repeat(64)}` }), TEST_KEY);
    const result = verifyReceipt(receipt, { publicKeyHex: publicKeyFor(TEST_KEY), quote });
    expect(result.valid).toBe(false);
    expect(result.reasons.some((r) => r.includes("quote_hash"))).toBe(true);
  });
});
