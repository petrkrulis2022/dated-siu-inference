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
    // The truncated first call is real, separately-billed usage — summed with the final call's,
    // not discarded: input 50+50=100, output 2+8=10, reasoning 95+90=185.
    expect(result.usage).toEqual({ input: 100, output: 10, cached_input: 0, reasoning: 185 });
  });

  it("does not resend temperature on the reasoning-truncation retry once the model has already rejected it", async () => {
    // Found live, 2026-09-24: a model that both rejects `temperature` (call 1) and needs the
    // reasoning-budget retry (call 2 truncated) previously had its 3rd call hardcode
    // `includeTemperature: true`, resending the very param call 1 established was rejected — a
    // real, uncaught 400 on a real run (claude-sonnet-5, a long gate-authoring prompt).
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const call = fetchMock.mock.calls.length;
      const body = JSON.parse(init.body as string);
      if (call === 1) {
        expect(body.temperature).toBe(0);
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: { message: "`temperature` is deprecated for this model." } }),
        };
      }
      expect(body.temperature).toBeUndefined();
      if (call === 2) {
        return {
          ok: true,
          json: async () => ({
            content: [{ type: "text", text: "" }],
            stop_reason: "max_tokens",
            usage: { input_tokens: 50, output_tokens: 2, output_tokens_details: { thinking_tokens: 95 } },
          }),
        };
      }
      return {
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "56" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 8, output_tokens_details: { thinking_tokens: 90 } },
        }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-sonnet-5", "prompt", PARAMS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.text).toBe("56");
    expect(result.deviations).toHaveLength(2);
  });

  it("surfaces stop_reason and every real content-block type — never inferred", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [
            { type: "thinking", thinking: "reasoning about it" },
            { type: "text", text: "hello world" },
          ],
          stop_reason: "end_turn",
          usage: { input_tokens: 120, output_tokens: 40 },
        }),
      })),
    );

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-test", "prompt", PARAMS);

    expect(result.stopReason).toBe("end_turn");
    expect(result.contentBlockTypes).toEqual(["thinking", "text"]);
  });

  it("real failure mode found live (P5 window 1, 2026-09-26): stop_reason max_tokens with no text content at all", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: "thinking", thinking: "a very long chain of reasoning" }],
          stop_reason: "max_tokens",
          usage: { input_tokens: 120, output_tokens: 4500 },
        }),
      })),
    );

    const adapter = createAnthropicAdapter("test-key");
    const result = await adapter("claude-test", "prompt", PARAMS);

    expect(result.text).toBe("");
    expect(result.stopReason).toBe("max_tokens");
    expect(result.contentBlockTypes).toEqual(["thinking"]);
  });

  describe("what a call actually sent (D59)", () => {
    const ok = { ok: true, json: async () => ({ content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } }) };
    const bodyOf = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => JSON.parse((fetchMock.mock.calls[call][1] as RequestInit).body as string);

    it("records the temperature it sent when the provider accepted it", async () => {
      const f = vi.fn(async () => ok);
      vi.stubGlobal("fetch", f);
      const r = await createAnthropicAdapter("k")("claude-test", "p", { temperature: 0.7, max_tokens: 100 });
      expect(bodyOf(f).temperature).toBe(0.7);
      expect(r.sent).toEqual({ temperature: 0.7 });
      expect(r.deviations).toEqual([]);
    });

    it("records the provider default, and the deviation, when the provider rejected the temperature and the call was retried without it", async () => {
      let n = 0;
      const f = vi.fn(async () => (++n === 1 ? { ok: false, status: 400, json: async () => ({ error: { message: "temperature may only be set to 1" } }) } : ok));
      vi.stubGlobal("fetch", f);
      const r = await createAnthropicAdapter("k")("claude-test", "p", { temperature: 0, max_tokens: 100 });
      expect(r.sent).toEqual({ temperature: "provider-default" });
      expect(r.deviations).toEqual(["temperature forced to provider default (request without temperature=0 was rejected)"]);
    });

    it("sends no temperature when asked not to, records the provider default, and needs no deviation because nothing was refused", async () => {
      const f = vi.fn(async () => ok);
      vi.stubGlobal("fetch", f);
      const r = await createAnthropicAdapter("k")("claude-test", "p", { temperature: 0.7, max_tokens: 100, omit_temperature: true });
      expect(f).toHaveBeenCalledTimes(1);
      expect("temperature" in bodyOf(f)).toBe(false);
      expect(r.sent).toEqual({ temperature: "provider-default" });
      expect(r.deviations).toEqual([]);
    });

    it("asks for manual thinking as a budget, and records it", async () => {
      const f = vi.fn(async () => ok);
      vi.stubGlobal("fetch", f);
      const r = await createAnthropicAdapter("k")("claude-test", "p", { temperature: 0, max_tokens: 4500, omit_temperature: true, thinking: { mode: "manual", budget_tokens: 2048 } });
      expect(bodyOf(f).thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
      expect(r.sent).toEqual({ temperature: "provider-default", thinking: { mode: "manual", budget_tokens: 2048 } });
    });

    it("asks for a summary of the thinking a model already does, changing nothing else, and records it", async () => {
      const f = vi.fn(async () => ok);
      vi.stubGlobal("fetch", f);
      const r = await createAnthropicAdapter("k")("claude-test", "p", { temperature: 0, max_tokens: 4500, omit_temperature: true, thinking: { mode: "summarized" } });
      expect(bodyOf(f).thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(r.sent?.thinking).toEqual({ mode: "summarized" });
    });

    it("sends no thinking field unless asked: the print's request is byte-for-byte what it was", async () => {
      const f = vi.fn(async () => ok);
      vi.stubGlobal("fetch", f);
      await createAnthropicAdapter("k")("claude-test", "p", PARAMS);
      expect(Object.keys(bodyOf(f)).sort()).toEqual(["max_tokens", "messages", "model", "temperature"]);
    });
  });
});
