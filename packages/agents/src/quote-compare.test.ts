import { describe, expect, it } from "vitest";
import type { DatumQuote } from "@datum/sdk";
import { pickCheaperQuote } from "./quote-compare.js";

function quoteWithSiu(siu: string): DatumQuote {
  return {
    schema_version: "1.1",
    siu,
    pattern: "fixed",
    model: "demo",
    rate_usd_per_siu: "0.05",
    amount_usd_max: "0.01",
    index_version: "SIU-2026a-illustrative-demo",
    print_id: "demo",
    print_hash: `0x${"0".repeat(64)}`,
    seller_id: "erc8004:0x0000000000000000000000000000000000000001",
    expiry: "2099-01-01T00:00:00Z",
    settlement: [
      {
        asset: "usdc",
        chain: "base-sepolia",
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        amount_max: "10000",
      },
    ],
    sig: `0x${"1".repeat(128)}`,
  };
}

describe("pickCheaperQuote", () => {
  it("picks the quote with the lower siu", () => {
    const cheap = quoteWithSiu("0.001");
    const expensive = quoteWithSiu("0.002");
    expect(pickCheaperQuote(cheap, expensive)).toBe(cheap);
    expect(pickCheaperQuote(expensive, cheap)).toBe(cheap);
  });

  it("prefers the first argument on a tie", () => {
    const a = quoteWithSiu("0.001");
    const b = quoteWithSiu("0.001");
    expect(pickCheaperQuote(a, b)).toBe(a);
  });
});
