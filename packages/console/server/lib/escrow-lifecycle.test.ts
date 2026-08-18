import { describe, expect, it } from "vitest";
import type { TouchstoneQuote } from "@touchstone/sdk";
import type { EventCache } from "../indexer/cache.js";
import { computeActivityAggregates, reconstructEscrowLifecycles } from "./escrow-lifecycle.js";

const QUOTE_HASH_A = `0x${"a".repeat(64)}`;
const QUOTE_HASH_B = `0x${"b".repeat(64)}`;
const QUOTE_HASH_C = `0x${"c".repeat(64)}`;
const BUYER = "0x0000000000000000000000000000000000000001";
const SELLER = "0x0000000000000000000000000000000000000002";
const ZERO = "0x0000000000000000000000000000000000000000";

function emptyEvents(): EventCache["events"] {
  return { opened: [], settled: [], expired: [], printPosted: [] };
}

function fakeQuote(overrides: Partial<TouchstoneQuote> = {}): TouchstoneQuote {
  return {
    schema_version: "1.1",
    siu: "0.001",
    pattern: "fixed",
    model: "demo-model",
    rate_usd_per_siu: "1.0000",
    amount_usd_max: "0.0010",
    index_version: "SIU-2026a",
    print_id: "demo-print",
    print_hash: `0x${"0".repeat(64)}`,
    seller_id: `erc8004:${SELLER}`,
    expiry: "2099-01-01T00:00:00Z",
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: ZERO, amount_max: "1000" }],
    sig: `0x${"1".repeat(128)}`,
    ...overrides,
  };
}

describe("reconstructEscrowLifecycles", () => {
  it("reconstructs an Opened -> Settled pair with the correct fee split", () => {
    const events: EventCache["events"] = {
      ...emptyEvents(),
      opened: [
        {
          quoteHash: QUOTE_HASH_A,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "1000",
          expiry: "9999999999",
          blockNumber: "100",
          txHash: "0xopen",
          timestamp: "2026-08-17T00:00:00.000Z",
        },
      ],
      settled: [
        {
          quoteHash: QUOTE_HASH_A,
          actualAmount: "600",
          receiptRef: QUOTE_HASH_A,
          blockNumber: "105",
          txHash: "0xsettle",
          timestamp: "2026-08-17T00:05:00.000Z",
        },
      ],
    };

    const [lifecycle] = reconstructEscrowLifecycles(events, "50", new Map());
    expect(lifecycle).toMatchObject({
      status: "settled",
      maxAmount: "1000",
      actualAmount: "600",
      // 600 * 50 / 10000 = 3
      feeAmount: "3",
      sellerReceived: "597",
      buyerRefund: "400",
      quote: null,
    });
  });

  it("reconstructs an Opened -> Expired pair", () => {
    const events: EventCache["events"] = {
      ...emptyEvents(),
      opened: [
        {
          quoteHash: QUOTE_HASH_B,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "500",
          expiry: "1",
          blockNumber: "100",
          txHash: "0xopen",
          timestamp: "2026-08-17T00:00:00.000Z",
        },
      ],
      expired: [
        {
          quoteHash: QUOTE_HASH_B,
          buyer: BUYER,
          amount: "500",
          blockNumber: "200",
          txHash: "0xexpire",
          timestamp: "2026-08-17T01:00:00.000Z",
        },
      ],
    };

    const [lifecycle] = reconstructEscrowLifecycles(events, "50", new Map());
    expect(lifecycle?.status).toBe("expired");
    expect(lifecycle?.buyerRefund).toBe("500");
    expect(lifecycle?.actualAmount).toBeUndefined();
  });

  it("leaves an escrow with no terminal event as open", () => {
    const events: EventCache["events"] = {
      ...emptyEvents(),
      opened: [
        {
          quoteHash: QUOTE_HASH_C,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "500",
          expiry: "9999999999",
          blockNumber: "100",
          txHash: "0xopen",
          timestamp: "2026-08-17T00:00:00.000Z",
        },
      ],
    };

    const [lifecycle] = reconstructEscrowLifecycles(events, "50", new Map());
    expect(lifecycle?.status).toBe("open");
    expect(lifecycle?.settledAt).toBeUndefined();
    expect(lifecycle?.expiredAt).toBeUndefined();
  });

  it("a settlement whose quote is not in the local quote cache joins as null, not a crash", () => {
    const events: EventCache["events"] = {
      ...emptyEvents(),
      opened: [
        {
          quoteHash: QUOTE_HASH_A,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "1000",
          expiry: "9999999999",
          blockNumber: "100",
          txHash: "0xopen",
          timestamp: "2026-08-17T00:00:00.000Z",
        },
      ],
      settled: [
        {
          quoteHash: QUOTE_HASH_A,
          actualAmount: "600",
          receiptRef: QUOTE_HASH_A,
          blockNumber: "105",
          txHash: "0xsettle",
          timestamp: "2026-08-17T00:05:00.000Z",
        },
      ],
    };

    // Local quote cache only knows about a DIFFERENT quoteHash.
    const localQuotes = new Map([[QUOTE_HASH_B.toLowerCase(), fakeQuote()]]);
    const [lifecycle] = reconstructEscrowLifecycles(events, "50", localQuotes);
    expect(lifecycle?.quote).toBeNull();
  });

  it("joins a known local quote's siu/model/print_id", () => {
    const events: EventCache["events"] = {
      ...emptyEvents(),
      opened: [
        {
          quoteHash: QUOTE_HASH_A,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "1000",
          expiry: "9999999999",
          blockNumber: "100",
          txHash: "0xopen",
          timestamp: "2026-08-17T00:00:00.000Z",
        },
      ],
    };
    const localQuotes = new Map([
      [QUOTE_HASH_A.toLowerCase(), fakeQuote({ siu: "0.005", model: "m1", print_id: "p1" })],
    ]);
    const [lifecycle] = reconstructEscrowLifecycles(events, "50", localQuotes);
    expect(lifecycle?.quote).toEqual({ siu: "0.005", model: "m1", printId: "p1" });
  });
});

describe("computeActivityAggregates", () => {
  it("sums settled volume by buyer and seller, ignoring open/expired escrows", () => {
    const events: EventCache["events"] = {
      opened: [
        {
          quoteHash: QUOTE_HASH_A,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "1000",
          expiry: "9999999999",
          blockNumber: "100",
          txHash: "0xopenA",
          timestamp: "t",
        },
        {
          quoteHash: QUOTE_HASH_B,
          buyer: BUYER,
          seller: SELLER,
          settler: ZERO,
          maxAmount: "500",
          expiry: "1",
          blockNumber: "101",
          txHash: "0xopenB",
          timestamp: "t",
        },
      ],
      settled: [
        {
          quoteHash: QUOTE_HASH_A,
          actualAmount: "600",
          receiptRef: QUOTE_HASH_A,
          blockNumber: "105",
          txHash: "0xsettle",
          timestamp: "t",
        },
      ],
      expired: [
        {
          quoteHash: QUOTE_HASH_B,
          buyer: BUYER,
          amount: "500",
          blockNumber: "200",
          txHash: "0xexpire",
          timestamp: "t",
        },
      ],
      printPosted: [],
    };

    const lifecycles = reconstructEscrowLifecycles(events, "50", new Map());
    const aggregates = computeActivityAggregates(lifecycles);
    expect(aggregates.totalUsdcSettledMinorUnits).toBe("600");
    expect(aggregates.byBuyer[BUYER]).toEqual({ count: 1, volumeMinorUnits: "600" });
    expect(aggregates.bySeller[SELLER]).toEqual({ count: 1, volumeMinorUnits: "600" });
  });
});
