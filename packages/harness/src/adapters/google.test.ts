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

  it("retries with reasoning accommodated above the task budget when mandatory reasoning truncates the completion", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const call = fetchMock.mock.calls.length;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "" }] }, finishReason: "MAX_TOKENS" }],
            usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 2, thoughtsTokenCount: 95 },
          }),
        };
      }
      // Second call: confirm the retry actually requested the accommodated budget.
      const body = JSON.parse(init.body as string);
      expect(body.generationConfig.maxOutputTokens).toBe(100 * (1 + 3)); // REASONING_BUDGET_MULTIPLE
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "56" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 8, thoughtsTokenCount: 90 },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGoogleAdapter("test-key");
    const result = await adapter("gemini-3.1-pro-preview", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("56");
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toContain("truncated by mandatory reasoning");
    expect(result.deviations[0]).toContain("400 tokens total"); // 100 * (1+3)
  });

  it("does not retry when the completion wasn't truncated by reasoning", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "clean answer" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 10, thoughtsTokenCount: 20 },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createGoogleAdapter("test-key");
    const result = await adapter("gemini-test", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.deviations).toEqual([]);
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
