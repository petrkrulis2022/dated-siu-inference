import { describe, expect, it } from "vitest";
import type { TouchstoneQuote } from "@touchstone/sdk";
import { claimMilliSiuForQuote, claimMintCostMinorUnits } from "./parity.js";

const quote = (
  amountMaxMinorUnits: string,
  printId = "2026-10-03-commodity",
): Pick<TouchstoneQuote, "print_id" | "settlement"> => ({
  print_id: printId,
  settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: amountMaxMinorUnits }],
});
const print = (nanoUsdPerSiu: bigint, printId = "2026-10-03-commodity") => ({ printId, nanoUsdPerSiu });

describe("claimMilliSiuForQuote — an fSIU payment costs what a USDC payment costs", () => {
  it("sizes a claim from the quote's PRICE at the print, by a hand-worked example", () => {
    // 2026-10-03 print: 1,424,000 nanoUSD per SIU = $0.001424. A 10 SIU quote at $0.001417 rounds
    // to a 4-decimal price of $0.0142 = 14,200 USDC minor units. 14,200 / 0.001424 = 9,971.9 mSIU,
    // so 9,972 — and 9,972 mSIU at the print is 14,200.1 minor units, which the contract floors to
    // exactly the 14,200 the dollar route would have cost.
    const q = claimMilliSiuForQuote(quote("14200"), print(1_424_000n));
    expect(q).toBe(9972n);
    expect(claimMintCostMinorUnits(q, 1_424_000n)).toBe(14200n);
  });

  it("is NOT the quote's SIU count: an off-print quote costs the same in either asset", () => {
    // The shape that made this a defect. Quoting 10 SIU at $0.05 is a $0.50 price; sizing the claim
    // as 10 SIU would have been worth about $0.107 at a $0.0107 print — an asset 79% cheaper.
    const q = claimMilliSiuForQuote(quote("500000", "2026-09-25"), print(10_700_000n, "2026-09-25"));
    expect(q).toBe(46729n);
    expect(claimMintCostMinorUnits(q, 10_700_000n)).toBe(500000n);
  });

  it("holds as a PROPERTY: never cheaper than the dollar price, and never dearer by a whole mSIU", () => {
    // Asserted over thousands of generated (price, print) pairs rather than as cases (§4.6ai), so a
    // rounding rule that is right for the examples and wrong at some print cannot hide.
    let seed = 12345n;
    const next = (mod: bigint): bigint => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
      return seed % mod;
    };
    for (let i = 0; i < 5000; i++) {
      const price = 1n + next(2_000_000_000n); // 1 minor unit .. $2,000
      const n = 50_000n + next(200_000_000n); // $0.00005 .. $0.20 per SIU
      const q = claimMilliSiuForQuote(quote(price.toString()), print(n));
      const cost = claimMintCostMinorUnits(q, n);
      expect(cost, `price ${price} at ${n}`).toBeGreaterThanOrEqual(price);
      // overpayment is strictly less than the dollar value of ONE milli-SIU at this print
      expect((cost - price) * 1_000_000n, `price ${price} at ${n}`).toBeLessThan(n);
    }
  });

  it("refuses a quote issued against a different print — the print in force must be the one it names", () => {
    expect(() => claimMilliSiuForQuote(quote("14200", "2026-10-02-commodity"), print(1_424_000n))).toThrow(
      /2026-10-02-commodity.*2026-10-03-commodity/s,
    );
  });

  it("refuses a zero price and a zero print rather than minting nothing or dividing by it", () => {
    expect(() => claimMilliSiuForQuote(quote("0"), print(1_424_000n))).toThrow(/no price/);
    expect(() => claimMilliSiuForQuote(quote("14200"), print(0n))).toThrow(/print rate/);
  });
});
