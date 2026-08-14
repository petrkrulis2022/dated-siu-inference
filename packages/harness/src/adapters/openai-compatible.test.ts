import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { temperature: 0 as const, max_tokens: 100 };

describe("createOpenAiCompatibleAdapter", () => {
  it("maps usage the same way as the native OpenAI adapter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "hi" } }],
          usage: { prompt_tokens: 15, completion_tokens: 8 },
        }),
      })),
    );

    const adapter = createOpenAiCompatibleAdapter({
      chatCompletionsUrl: "https://example.com/v1/chat/completions",
      apiKey: "test-key",
    });
    const result = await adapter("some/model", "prompt", PARAMS);
    expect(result.usage).toEqual({ input: 15, output: 8, cached_input: 0, reasoning: 0 });
  });

  it("merges extraBody into the request — this is how OpenRouter's provider.only pin reaches the request", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedBody = JSON.parse(init.body as string);
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        };
      }),
    );

    const adapter = createOpenAiCompatibleAdapter({
      chatCompletionsUrl: "https://openrouter.ai/api/v1/chat/completions",
      apiKey: "test-key",
      extraBody: { provider: { only: ["deepinfra"] } },
    });
    await adapter("meta-llama/llama-3.3-70b-instruct", "prompt", PARAMS);

    expect(capturedBody?.provider).toEqual({ only: ["deepinfra"] });
  });

  it("includes extraHeaders in the request", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        capturedHeaders = init.headers as Record<string, string>;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "hi" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        };
      }),
    );

    const adapter = createOpenAiCompatibleAdapter({
      chatCompletionsUrl: "https://example.com/v1/chat/completions",
      apiKey: "test-key",
      extraHeaders: { "HTTP-Referer": "https://datum.example" },
    });
    await adapter("some/model", "prompt", PARAMS);

    expect(capturedHeaders?.["HTTP-Referer"]).toBe("https://datum.example");
  });
});
