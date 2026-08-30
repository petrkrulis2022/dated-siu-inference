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

  it("maps thinking_tokens to reasoning when extended thinking is reported", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 50, output_tokens: 10, output_tokens_details: { thinking_tokens: 30 } },
        }),
      })),
    );

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-test", "prompt", PARAMS);
    expect(result.usage.reasoning).toBe(30);
  });

  it("retries with reasoning accommodated above the task budget when mandatory reasoning truncates the completion", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "" }],
            stop_reason: "max_tokens",
            usage: {
              input_tokens: 50,
              output_tokens: 2,
              output_tokens_details: { thinking_tokens: 95 },
            },
          }),
        };
      }
      const body = JSON.parse(init.body as string);
      expect(body.max_tokens).toBe(100 * (1 + 3)); // REASONING_BUDGET_MULTIPLE
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "56" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 50,
            output_tokens: 8,
            output_tokens_details: { thinking_tokens: 90 },
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-sonnet-5", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("56");
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toContain("truncated by mandatory reasoning");
  });
});
