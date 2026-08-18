import { describe, expect, it } from "vitest";
import { verifyReceiptSignature, buildQuoteBody, signQuote } from "@touchstone/sdk";
import { publicKeyFor } from "@touchstone/print";
import type { OnChainSettlement, SettlementReader } from "../settlement/reader.js";
import { verifyReceiptTool } from "./verify-receipt.js";

const TEST_KEY = `0x${"11".repeat(32)}`;
const SELLER_KEY = `0x${"33".repeat(32)}`;

/** verify_receipt is now stateless (P13/P14): the caller supplies the full quote and the reader
 * binds it to the settlement by hash. FakeReader below stands in for that already-tested reader
 * (see settlement/on-chain.test.ts, which runs the real thing against live Base Sepolia) so these
 * tests can focus purely on verifyReceiptTool's own logic — chain gating, matched/unmatched,
 * quote-shape validation, and no-settlement handling. */
class FakeReader implements SettlementReader {
  constructor(private readonly settlement: OnChainSettlement | null) {}
  read(): Promise<OnChainSettlement | null> {
    return Promise.resolve(this.settlement);
  }
}

const quote = signQuote(
  buildQuoteBody({
    siu: "0.0676",
    pattern: "fixed",
    model: "anthropic-sonnet-5",
    rateUsdPerSiu: "1.0000",
    indexVersion: "SIU-2026a",
    printId: "2026-08-14",
    printHash: `0x${"cc".repeat(32)}`,
    sellerId: "erc8004:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    chain: "base-sepolia",
    expiresInSeconds: 3600,
  }),
  SELLER_KEY,
);

const settled: OnChainSettlement = {
  quoteHash: `0x${"a".repeat(64)}`,
  actualAmountMinorUnits: "67600",
  maxAmountMinorUnits: "67600",
  receiptRef: `0x${"b".repeat(64)}`,
  printRef: "2026-08-14",
};

describe("verifyReceiptTool", () => {
  it("signs a receipt with matched: true when the actual amount is within the max", async () => {
    const receipt = await verifyReceiptTool(
      { chain: "base", tx_hash: "0xdeadbeef", quote },
      new FakeReader(settled),
      TEST_KEY,
    );
    expect(receipt.matched).toBe(true);
    expect(receipt.amount_paid_usd).toBe("0.067600");
    expect(receipt.amount_quoted_usd).toBe("0.067600");
    expect(receipt.quote_hash).toBe(settled.quoteHash);
    expect(receipt.print_ref).toBe("2026-08-14");
    expect(verifyReceiptSignature(receipt, publicKeyFor(TEST_KEY)).valid).toBe(true);
  });

  it("signs a receipt with matched: false, honestly, when the actual amount exceeds the max", async () => {
    const overspent: OnChainSettlement = { ...settled, actualAmountMinorUnits: "100000" };
    const receipt = await verifyReceiptTool(
      { chain: "base", tx_hash: "0xdeadbeef", quote },
      new FakeReader(overspent),
      TEST_KEY,
    );
    expect(receipt.matched).toBe(false);
  });

  it("rejects an unsupported chain before ever calling the reader", async () => {
    const reader = new FakeReader(settled);
    const spy = { called: false };
    reader.read = () => {
      spy.called = true;
      return Promise.resolve(settled);
    };
    await expect(
      verifyReceiptTool({ chain: "ethereum", tx_hash: "0xdead", quote }, reader, TEST_KEY),
    ).rejects.toThrow(/Unsupported chain/);
    expect(spy.called).toBe(false);
  });

  it("rejects a quote that fails the published schema before ever calling the reader", async () => {
    const reader = new FakeReader(settled);
    const spy = { called: false };
    reader.read = () => {
      spy.called = true;
      return Promise.resolve(settled);
    };
    await expect(
      verifyReceiptTool(
        { chain: "base", tx_hash: "0xdead", quote: { not: "a quote" } },
        reader,
        TEST_KEY,
      ),
    ).rejects.toThrow(/quote fails the published touchstone-quote schema/);
    expect(spy.called).toBe(false);
  });

  it("throws when the reader finds no settlement for the transaction", async () => {
    await expect(
      verifyReceiptTool(
        { chain: "base", tx_hash: "0xdead", quote },
        new FakeReader(null),
        TEST_KEY,
      ),
    ).rejects.toThrow(/No settlement found/);
  });

  it("accepts base-sepolia as a supported test chain", async () => {
    const receipt = await verifyReceiptTool(
      { chain: "base-sepolia", tx_hash: "0xdead", quote },
      new FakeReader(settled),
      TEST_KEY,
    );
    expect(receipt.chain).toBe("base-sepolia");
  });
});
