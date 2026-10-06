import { describe, expect, it } from "vitest";
import { escrowSettleAmount } from "./settle-escrow.js";

describe("escrowSettleAmount — what a settlement is for", () => {
  // Found by the currency lab's fork walk, 2026-10-06: a quote paid partly in claims opens an escrow for the
  // dollar leg only, and the seller's default settlement asked for the whole quoted amount and was refused.
  it("is the quote's ceiling for a quote paid wholly in dollars, as it always was", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 1700n })).toBe(1700n);
  });

  it("is what the escrow holds for a quote paid partly in claims, so the dollar leg can be taken", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 850n })).toBe(850n);
  });

  it("falls back to the quote's ceiling when the escrow could not be read", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n })).toBe(1700n);
  });

  it("never exceeds the quote's ceiling, even if a read says the escrow holds more", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 9999n })).toBe(1700n);
  });

  it("treats a zero reading as unreadable, not as an escrow holding nothing", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 0n })).toBe(1700n);
  });

  it("lets a seller settle for less than the escrow holds — quote accuracy is scored on it", () => {
    expect(escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 850n, actualAmountUsd: "0.0005" })).toBe(500n);
  });

  it("refuses more than the escrow holds, and says why when the quote was paid partly in claims", () => {
    expect(() => escrowSettleAmount({ quotedMaxMinorUnits: 1700n, heldMinorUnits: 850n, actualAmountUsd: "0.0017" })).toThrow(
      /exceeds the escrow's own maxAmount \(850 minor units, the dollar part of a quote paid partly in claims\)/,
    );
    expect(() => escrowSettleAmount({ quotedMaxMinorUnits: 1700n, actualAmountUsd: "0.0018" })).toThrow(/\(1700 minor units\)/);
  });
});
