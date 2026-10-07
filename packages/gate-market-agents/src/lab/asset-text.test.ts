import { describe, expect, it } from "vitest";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { DIRECT_SENTENCE, ESCROW_SENTENCES, LAB_ASSET_DESCRIPTION } from "./asset-text.js";

describe("the lab's asset text (D36)", () => {
  it("is the canonical text with exactly the escrow sentences replaced, and nothing else changed", () => {
    expect(CANONICAL_ASSET_DESCRIPTION).toContain(ESCROW_SENTENCES);
    expect(LAB_ASSET_DESCRIPTION).toBe(CANONICAL_ASSET_DESCRIPTION.replace(ESCROW_SENTENCES, DIRECT_SENTENCE));
    // Everything before and after the replaced sentences is byte for byte the canonical text, so the fSIU paragraph in
    // particular is untouched.
    const at = CANONICAL_ASSET_DESCRIPTION.indexOf(ESCROW_SENTENCES);
    const head = CANONICAL_ASSET_DESCRIPTION.slice(0, at);
    const tail = CANONICAL_ASSET_DESCRIPTION.slice(at + ESCROW_SENTENCES.length);
    expect(LAB_ASSET_DESCRIPTION.startsWith(head)).toBe(true);
    expect(LAB_ASSET_DESCRIPTION.endsWith(tail)).toBe(true);
    expect(LAB_ASSET_DESCRIPTION.slice(head.length, LAB_ASSET_DESCRIPTION.length - tail.length)).toBe(DIRECT_SENTENCE);
  });

  it("says nothing of escrow, a seller settling for less, or money returning: none of it happens in the lab", () => {
    for (const word of ["escrow", "settles", "settle for less", "returns to you"]) {
      expect(LAB_ASSET_DESCRIPTION, word).not.toContain(word);
    }
  });

  it("states a fact about USDC and asserts nothing about which asset to use", () => {
    expect(LAB_ASSET_DESCRIPTION).toContain("USDC is a dollar. 1 USDC = $1.");
    expect(LAB_ASSET_DESCRIPTION).toContain("it reaches the seller\nat once.");
    expect(LAB_ASSET_DESCRIPTION).not.toMatch(/\b(prefer|should|better|cheaper|recommend)\b/i);
  });

  it("keeps the canonical text's claim that either asset, or both, settles any quote", () => {
    expect(LAB_ASSET_DESCRIPTION).toContain("Any quote can be settled in either, or partly in each.");
  });
});
