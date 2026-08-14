import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleAdapter } from "./google.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { temperature: 0 as const, max_tokens: 100 };

describe("createGoogleAdapter", () => {
  it("maps thoughtsTokenCount to reasoning and cachedContentTokenCount to cached_input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "gemini says hi" }] } }],
          usageMetadata: {
            promptTokenCount: 300,
            candidatesTokenCount: 60,
            thoughtsTokenCount: 80,
            cachedContentTokenCount: 20,
          },
        }),
      })),
    );

    const adapter = createGoogleAdapter("test-key");
    const result = await adapter("gemini-test", "prompt", PARAMS);

    expect(result.text).toBe("gemini says hi");
    expect(result.usage).toEqual({ input: 300, output: 60, cached_input: 20, reasoning: 80 });
  });

  it("joins multiple text parts into one string", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "part one " }, { text: "part two" }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        }),
      })),
    );

    const adapter = createGoogleAdapter("test-key");
    const result = await adapter("gemini-test", "prompt", PARAMS);
    expect(result.text).toBe("part one part two");
  });
});
