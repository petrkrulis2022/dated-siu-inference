import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenAiAdapter } from "./openai.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { temperature: 0 as const, max_tokens: 100 };

describe("createOpenAiAdapter", () => {
  it("maps reasoning_tokens and cached_tokens separately from the base usage counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "answer" } }],
          usage: {
            prompt_tokens: 200,
            completion_tokens: 150,
            completion_tokens_details: { reasoning_tokens: 100 },
            prompt_tokens_details: { cached_tokens: 50 },
          },
        }),
      })),
    );

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("gpt-test", "prompt", PARAMS);

    expect(result.text).toBe("answer");
    expect(result.usage).toEqual({ input: 200, output: 150, cached_input: 50, reasoning: 100 });
  });

  it("defaults reasoning and cached_input to 0 when the provider doesn't report them", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "answer" } }],
          usage: { prompt_tokens: 20, completion_tokens: 5 },
        }),
      })),
    );

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("gpt-test", "prompt", PARAMS);
    expect(result.usage).toEqual({ input: 20, output: 5, cached_input: 0, reasoning: 0 });
  });

  it("retries without temperature and records a deviation when the provider rejects it", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: { message: "Unsupported value: 'temperature'" } }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        };
      }),
    );

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("o-reasoning", "prompt", PARAMS);

    expect(callCount).toBe(2);
    expect(result.deviations).toHaveLength(1);
  });
});
