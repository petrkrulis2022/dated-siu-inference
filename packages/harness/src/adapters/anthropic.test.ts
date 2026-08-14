import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnthropicAdapter } from "./anthropic.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { temperature: 0 as const, max_tokens: 100 };

describe("createAnthropicAdapter", () => {
  it("maps a successful response, including cache_read_input_tokens as cached_input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "hello world" }],
          usage: {
            input_tokens: 120,
            output_tokens: 40,
            cache_read_input_tokens: 30,
          },
        }),
      })),
    );

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-test", "prompt", PARAMS);

    expect(result.text).toBe("hello world");
    expect(result.usage).toEqual({ input: 120, output: 40, cached_input: 30, reasoning: 0 });
    expect(result.deviations).toEqual([]);
  });

  it("retries without temperature and records a deviation when the provider rejects it", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        callCount++;
        const body = JSON.parse(init.body as string);
        if (callCount === 1) {
          expect(body.temperature).toBe(0);
          return {
            ok: false,
            status: 400,
            json: async () => ({
              error: { message: "temperature is not supported for this model" },
            }),
          };
        }
        expect(body.temperature).toBeUndefined();
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "ok" }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        };
      }),
    );

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-reasoning", "prompt", PARAMS);

    expect(callCount).toBe(2);
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toMatch(/temperature/i);
  });

  it("propagates a non-temperature 400 error without retrying", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "invalid model id" } }),
      })),
    );

    const adapter = createAnthropicAdapter("test-key");
    await expect(adapter("bogus-model", "prompt", PARAMS)).rejects.toThrow(/400/);
  });
});
