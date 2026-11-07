/** New in v2 (marketplace-redesign-v2.md, items 8-10): three additive, optional fields. The rest of parseParams is already exercised indirectly by every other test's loadParams() call. */
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadParams, PARAMS_PATH } from "./params.js";

const V2_DRAFT_PATH = join(dirname(PARAMS_PATH), "economy-params.v2.json");

describe("parseParams: v2's new optional fields", () => {
  it("the committed v1 file (frozen, D87) carries none of them -- loadParams must not invent a value", () => {
    const p = loadParams(PARAMS_PATH);
    expect(p.unmetNeedCostMicroSiu).toBeUndefined();
    expect(p.forwardVisibilityWindows).toBeUndefined();
    expect(p.printHistoryStartDate).toBeUndefined();
    expect(p.hedger.latePenaltyUsdcPerBrief).toBeUndefined();
    expect(p.counted?.seats).toEqual(["claude-sonnet-5", "gpt-5.1"]); // unchanged, still the pre-registered D92 rotation
  });

  it("the v2 draft file parses every new field, and item 13's single-seat rotation", () => {
    const p = loadParams(V2_DRAFT_PATH);
    expect(p.unmetNeedCostMicroSiu).toBe(200_000n);
    expect(p.forwardVisibilityWindows).toBe(2);
    expect(p.printHistoryStartDate).toBe("2026-09-02");
    expect(p.hedger.latePenaltyUsdcPerBrief).toBe(50_000n);
    expect(p.counted?.seats).toEqual(["claude-sonnet-5"]);
  });
});
