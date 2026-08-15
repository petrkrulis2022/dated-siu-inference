import { describe, expect, it } from "vitest";
import type { Receipt } from "../types/generated/receipt.schema.js";
import { publicKeyFor } from "../crypto/sign.js";
import {
  receiptBodyHashHex,
  receiptBodyOf,
  signReceipt,
  verifyReceiptSignature,
  type ReceiptBody,
} from "./sign.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const OTHER_KEY = `0x${"22".repeat(32)}`;

const body: ReceiptBody = {
  schema_version: "1.0",
  quote_hash: `0x${"a".repeat(64)}`,
  chain: "base",
  tx_ref: `0x${"b".repeat(64)}`,
  amount_quoted_usd: "0.0676",
  amount_paid_usd: "0.0676",
  matched: true,
  print_ref: "2026-08-14",
};

describe("signReceipt / verifyReceiptSignature", () => {
  it("produces a signature that verifies against its own body", () => {
    const receipt = signReceipt(body, TEST_KEY);
    expect(verifyReceiptSignature(receipt, publicKeyFor(TEST_KEY)).valid).toBe(true);
  });

  it("writes the matching public key into the receipt", () => {
    const receipt = signReceipt(body, TEST_KEY);
    expect(receipt.public_key).toBe(publicKeyFor(TEST_KEY));
  });

  it("is deterministic — the same body and key produce the same signature", () => {
    expect(signReceipt(body, TEST_KEY).signature).toBe(signReceipt(body, TEST_KEY).signature);
  });

  it("DETECTS TAMPERING: a changed amount_paid_usd invalidates the signature", () => {
    const receipt = signReceipt(body, TEST_KEY);
    const tampered = { ...receipt, amount_paid_usd: "999.000000" } as Receipt;
    expect(verifyReceiptSignature(tampered, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("rejects a signature made by a different key", () => {
    const receipt = signReceipt(body, OTHER_KEY);
    expect(verifyReceiptSignature(receipt, publicKeyFor(TEST_KEY)).valid).toBe(false);
  });

  it("refuses to sign a body that fails the published schema", () => {
    const broken = { ...body, matched: "yes" } as unknown as ReceiptBody;
    expect(() => signReceipt(broken, TEST_KEY)).toThrow(/Refusing to sign/);
  });
});

describe("receiptBodyOf / receiptBodyHashHex", () => {
  it("strips signature and public_key before hashing", () => {
    const receipt = signReceipt(body, TEST_KEY);
    const stripped = receiptBodyOf(receipt) as Partial<Receipt>;
    expect(stripped.signature).toBeUndefined();
    expect(stripped.public_key).toBeUndefined();
  });

  it("gives the same hash before and after signing", () => {
    const receipt = signReceipt(body, TEST_KEY);
    expect(receiptBodyHashHex(receipt)).toBe(receiptBodyHashHex(body));
  });
});
