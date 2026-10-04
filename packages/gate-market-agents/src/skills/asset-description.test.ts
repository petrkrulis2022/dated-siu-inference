import { describe, expect, it } from "vitest";
import { CANONICAL_ASSET_DESCRIPTION } from "./asset-description.js";

describe("CANONICAL_ASSET_DESCRIPTION — spec §8.5, verbatim", () => {
  const paragraph = (name: "USDC" | "fSIU"): string => {
    const found = CANONICAL_ASSET_DESCRIPTION.split("\n\n").find((p) => p.startsWith(`${name} is`));
    if (!found) throw new Error(`no ${name} paragraph`);
    return found;
  };

  it("matches the spec's own text exactly — this is the property F1's validity rests on", () => {
    expect(CANONICAL_ASSET_DESCRIPTION).toBe(
      `You hold two assets.

USDC is a dollar. 1 USDC = $1. Every counterparty accepts it, and it has
no window and does not expire. Paid against a quote, it is held in escrow
until the seller settles. A seller may settle for less than it quoted, and
whatever it does not claim returns to you. Its dollar value never moves.

fSIU is a dated claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C from the
issuer named on the claim, during window W. A presented claim that the
issuer does not deliver can be settled against its bond once the window
closes. It cannot be redeemed before the window opens, and expires when it
closes. Its dollar value moves with the published price of work.

Any quote can be settled in either, or partly in each.`,
    );
  });

  it("is neutral — mentions USDC and fSIU an equal number of times, no comparative language", () => {
    const usdcCount = (CANONICAL_ASSET_DESCRIPTION.match(/USDC/g) ?? []).length;
    const fsiuCount = (CANONICAL_ASSET_DESCRIPTION.match(/fSIU/g) ?? []).length;
    expect(usdcCount).toBe(fsiuCount);
    expect(CANONICAL_ASSET_DESCRIPTION.toLowerCase()).not.toMatch(/better|prefer|recommend/);
  });

  it("keeps the two paragraphs close in length, so neither asset gets the louder description", () => {
    // 294 vs 424 characters when written, 1.44x. The original text was about 5x. A bound rather
    // than an equality because fSIU has a window, an issuer, a bond and an expiry that USDC does
    // not, and padding USDC with filler to match would be worse than the gap.
    const ratio = paragraph("fSIU").length / paragraph("USDC").length;
    expect(ratio).toBeGreaterThan(1);
    expect(ratio).toBeLessThan(1.6);
  });

  it("makes no claim that is false of the run", () => {
    // Both of these sentences were in the original and both were false. A quote cannot list fSIU
    // (build 1 permits one settlement entry, USDC), and nothing is "listed" by counterparties.
    expect(CANONICAL_ASSET_DESCRIPTION).not.toContain("Sellers state which they accept");
    expect(CANONICAL_ASSET_DESCRIPTION).not.toContain("accepted by counterparties that list it");
  });

  it("states the mechanics that hold in every window, and names no issuer", () => {
    // Redeemable from the issuer named on the claim; recoverable from its bond if a presented
    // claim is not delivered; expires when the window closes. And nothing about WHICH issuer will
    // serve or fail, which is exactly what this instrument varies between windows.
    // Whitespace-normalised: the constant is hard-wrapped for the spec, and a line break moving
    // must not read as a mechanic disappearing.
    const f = paragraph("fSIU").replace(/\s+/g, " ");
    expect(f).toContain("issuer named on the claim");
    expect(f).toContain("settled against its bond once the window closes");
    expect(f).toContain("expires when it closes");
    expect(CANONICAL_ASSET_DESCRIPTION).not.toMatch(/ISSUER-[AB]|non-serving|will not serve/i);
  });

  it("describes the dollar asset's own mechanics, not just the claim's", () => {
    const u = paragraph("USDC");
    expect(u).toContain("does not expire");
    expect(u).toContain("held in escrow");
    expect(u).toContain("dollar value never moves");
  });
});
