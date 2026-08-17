import { describe, expect, it } from "vitest";
import type { EscrowLifecycle } from "./escrow-lifecycle.js";
import { computeQuotedVsPaid } from "./quoted-vs-paid.js";

function settled(overrides: Partial<EscrowLifecycle> = {}): EscrowLifecycle {
  return {
    quoteHash: "0xabc",
    buyer: "0xbuyer",
    seller: "0xseller",
    settler: "0x0000000000000000000000000000000000000000",
    maxAmount: "1000000",
    status: "settled",
    openedAt: "t",
    openedTx: "0xopen",
    expiryUnix: "9999999999",
    actualAmount: "1000000",
    settledAt: "t",
    settledTx: "0xsettle",
    quote: { siu: "1", model: "m", printId: "p" },
    ...overrides,
  };
}

describe("computeQuotedVsPaid", () => {
  it("matches when actualAmount equals maxAmount", () => {
    const { rows } = computeQuotedVsPaid([settled()]);
    expect(rows[0]?.matched).toBe(true);
    expect(rows[0]?.amountQuotedUsd).toBe("1.000000");
    expect(rows[0]?.amountPaidUsd).toBe("1.000000");
  });

  it("matches when actualAmount is below maxAmount (a normal refund)", () => {
    const { rows } = computeQuotedVsPaid([settled({ actualAmount: "400000" })]);
    expect(rows[0]?.matched).toBe(true);
  });

  it("flags a mismatch when actualAmount exceeds maxAmount — the dishonest-seller case", () => {
    const { rows } = computeQuotedVsPaid([
      settled({ maxAmount: "500000", actualAmount: "900000" }),
    ]);
    expect(rows[0]?.matched).toBe(false);
    expect(rows[0]?.amountPaidUsd).toBe("0.900000");
    expect(rows[0]?.amountQuotedUsd).toBe("0.500000");
  });

  it("counts settlements with no known quote separately, without a row", () => {
    const { rows, unknownQuoteCount } = computeQuotedVsPaid([settled({ quote: null })]);
    expect(rows).toHaveLength(0);
    expect(unknownQuoteCount).toBe(1);
  });

  it("ignores open and expired escrows entirely", () => {
    const { rows, unknownQuoteCount } = computeQuotedVsPaid([
      settled({ status: "open", actualAmount: undefined }),
      settled({ status: "expired", actualAmount: undefined }),
    ]);
    expect(rows).toHaveLength(0);
    expect(unknownQuoteCount).toBe(0);
  });
});
