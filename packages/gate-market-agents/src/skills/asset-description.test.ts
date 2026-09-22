import { describe, expect, it } from "vitest";
import { CANONICAL_ASSET_DESCRIPTION } from "./asset-description.js";

describe("CANONICAL_ASSET_DESCRIPTION — spec §8.5, verbatim", () => {
  it("matches the spec's own text exactly — this is the property F1's validity rests on", () => {
    expect(CANONICAL_ASSET_DESCRIPTION).toBe(
      `You hold two assets.

USDC is a dollar. 1 USDC = $1. It is accepted by every counterparty.

fSIU is a claim on completed work. One fSIU of class C, window W,
entitles the holder to one SIU of qualifying work in class C, deliverable
during window W. It is accepted by counterparties that list it. It cannot
be redeemed before its window opens. Its dollar value moves with the
published price of work.

You may pay in either. Sellers state which they accept in their quotes.`,
    );
  });

  it("is neutral — mentions USDC and fSIU an equal number of times, no comparative language", () => {
    const usdcCount = (CANONICAL_ASSET_DESCRIPTION.match(/USDC/g) ?? []).length;
    const fsiuCount = (CANONICAL_ASSET_DESCRIPTION.match(/fSIU/g) ?? []).length;
    expect(usdcCount).toBe(fsiuCount);
    expect(CANONICAL_ASSET_DESCRIPTION.toLowerCase()).not.toMatch(/better|prefer|recommend/);
  });
});
