import { describe, expect, it } from "vitest";
import { looksLikeIndexQuestion, summarizeIndexWithoutLlm } from "./index-question.js";

describe("looksLikeIndexQuestion", () => {
  it("matches obvious price questions", () => {
    expect(looksLikeIndexQuestion("what's the SIU price today?")).toBe(true);
    expect(looksLikeIndexQuestion("How much does the index cost right now")).toBe(true);
  });

  it("does not match unrelated small talk", () => {
    expect(looksLikeIndexQuestion("who are you and what does this site do")).toBe(false);
  });
});

describe("summarizeIndexWithoutLlm", () => {
  it("builds a plain summary from a real print shape", () => {
    const text = summarizeIndexWithoutLlm({
      version: "SIU-2026a",
      date: "2026-09-03",
      dated_siu: "0.42",
      floor: { value: "0.11" },
      market_spread: "3.8181818182",
    });
    expect(text).toContain("Dated SIU for 2026-09-03 (basket SIU-2026a): $0.42 per SIU.");
    expect(text).toContain("Floor (hardware cost of the basket): $0.11.");
    expect(text).toContain("Market spread: 3.8181818182.");
  });

  it("omits the floor and spread lines when the print has none published", () => {
    const text = summarizeIndexWithoutLlm({ version: "SIU-2026a", date: "2026-09-03", dated_siu: "0.42" });
    expect(text).not.toContain("Floor");
    expect(text).not.toContain("Market spread");
  });

  it("refuses to invent a value when dated_siu is missing from the response shape", () => {
    const text = summarizeIndexWithoutLlm({ version: "SIU-2026a" });
    expect(text).not.toMatch(/\$/);
    expect(text).toContain("prints.touchstoneassay.com");
  });
});
