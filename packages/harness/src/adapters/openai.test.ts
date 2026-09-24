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

  it("retries with reasoning accommodated above the task budget when mandatory reasoning truncates the completion", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      if (fetchMock.mock.calls.length === 1) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: {
              prompt_tokens: 50,
              completion_tokens: 2,
              completion_tokens_details: { reasoning_tokens: 95 },
            },
          }),
        };
      }
      const body = JSON.parse(init.body as string);
      expect(body.max_completion_tokens).toBe(100 * (1 + 3)); // REASONING_BUDGET_MULTIPLE
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "56" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 50,
            completion_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 90 },
          },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("gpt-5.1", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.text).toBe("56");
    expect(result.deviations).toHaveLength(1);
    expect(result.deviations[0]).toContain("truncated by mandatory reasoning");
    // The truncated first call is real, separately-billed usage — summed with the final call's,
    // not discarded: input 50+50=100, output 2+8=10, reasoning 95+90=185.
    expect(result.usage).toEqual({ input: 100, output: 10, cached_input: 0, reasoning: 185 });
  });

  it("does not resend temperature on the reasoning-truncation retry once the model has already rejected it", async () => {
    // Same real bug as anthropic.test.ts's identical test — see its comment.
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const call = fetchMock.mock.calls.length;
      const body = JSON.parse(init.body as string);
      if (call === 1) {
        expect(body.temperature).toBe(0);
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "Unsupported value: 'temperature'" } }),
        };
      }
      expect(body.temperature).toBeUndefined();
      if (call === 2) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "" }, finish_reason: "length" }],
            usage: { prompt_tokens: 50, completion_tokens: 2, completion_tokens_details: { reasoning_tokens: 95 } },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "56" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 50, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 90 } },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("o-reasoning", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("56");
    expect(result.deviations).toHaveLength(2);
  });

  it("does not retry when the completion wasn't truncated by reasoning", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "clean answer" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 50,
          completion_tokens: 10,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createOpenAiAdapter("test-key");
    const result = await adapter("gpt-test", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.deviations).toEqual([]);
  });
});
