import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { buildVerifyInfo } from "./verify.js";

// The real, published first print — signed with the real TOUCHSTONE_PUBLISHER_KEY, so this
// exercises the actual recovery math against a genuine signature rather than a synthetic one.
const REAL_PRINT: Print = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../data/prints/2026-08-18.json"), "utf-8"),
);
const REAL_PUBLISHER = "0x284ff2F8605Ff8AFeDa6959B856Bb7E6d48f845a";

describe("buildVerifyInfo", () => {
  it("recovers the real publisher from the real print's signature", () => {
    const info = buildVerifyInfo(REAL_PRINT, REAL_PUBLISHER);
    expect(info.matchesPublisher).toBe(true);
    expect(info.recoveredSigner.toLowerCase()).toBe(REAL_PUBLISHER.toLowerCase());
    expect(info.bodyHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("reports no match against the wrong publisher address, rather than asserting true anyway", () => {
    const info = buildVerifyInfo(REAL_PRINT, "0x000000000000000000000000000000000000dEaD");
    expect(info.matchesPublisher).toBe(false);
  });
});
