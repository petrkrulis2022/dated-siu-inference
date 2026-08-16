import { describe, expect, it } from "vitest";
import { escrowMatchesQuote, type EscrowRead } from "./escrow-client.js";

const SELLER = "0xE743EBBE16Bc136D8fb5F98bccC927aA7B9Ce0cd";
const BUYER = "0xD7CA8219C8AfA07b455Ab7e004FC5381B3727B1e";

function openEscrow(overrides: Partial<EscrowRead> = {}): EscrowRead {
  return {
    buyer: BUYER,
    expiry: 2_000_000_000n,
    status: 1, // Open
    seller: SELLER,
    settler: "0x0000000000000000000000000000000000000000",
    maxAmount: 100_000n,
    ...overrides,
  };
}

const EXPECTED = { seller: SELLER, maxAmount: 100_000n, expiryUnix: 2_000_000_000n };

describe("escrowMatchesQuote", () => {
  it("matches a genuinely open, correctly funded escrow", () => {
    expect(escrowMatchesQuote(openEscrow(), EXPECTED)).toBe(true);
  });

  it("is case-insensitive on the seller address", () => {
    expect(escrowMatchesQuote(openEscrow({ seller: SELLER.toLowerCase() }), EXPECTED)).toBe(true);
  });

  it("rejects a not-yet-funded (None) escrow — the exact stale-read symptom seen live", () => {
    expect(
      escrowMatchesQuote(
        openEscrow({
          status: 0,
          seller: "0x0000000000000000000000000000000000000000",
          maxAmount: 0n,
        }),
        EXPECTED,
      ),
    ).toBe(false);
  });

  it("rejects a settled escrow — funding must be checked before it's spent", () => {
    expect(escrowMatchesQuote(openEscrow({ status: 2 }), EXPECTED)).toBe(false);
  });

  it("rejects an escrow funded for a different seller", () => {
    expect(
      escrowMatchesQuote(
        openEscrow({ seller: "0x0000000000000000000000000000000000000009" }),
        EXPECTED,
      ),
    ).toBe(false);
  });

  it("rejects an escrow funded below the quote's committed maxAmount", () => {
    expect(escrowMatchesQuote(openEscrow({ maxAmount: 99n }), EXPECTED)).toBe(false);
  });

  it("rejects an escrow whose expiry is shorter than what the quote committed to", () => {
    expect(escrowMatchesQuote(openEscrow({ expiry: 1n }), EXPECTED)).toBe(false);
  });

  it("accepts an escrow funded for more than required (a stricter buyer than necessary)", () => {
    expect(escrowMatchesQuote(openEscrow({ maxAmount: 200_000n }), EXPECTED)).toBe(true);
  });
});
