import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleAdapter } from "./google.js";
import { createOpenAiAdapter } from "./openai.js";
import { createOpenAiCompatibleAdapter } from "./openai-compatible.js";
import type { Adapter, AdapterParams } from "./types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The three adapters that gained `omit_temperature` and `sent` (D65), each with the body field its API carries the temperature in and a response of its own shape. */
const CASES: { name: string; make: () => Adapter; temperatureOf: (body: Record<string, unknown>) => unknown; ok: unknown }[] = [
  {
    name: "openai",
    make: () => createOpenAiAdapter("k"),
    temperatureOf: (b) => b.temperature,
    ok: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  },
  {
    name: "openai-compatible",
    make: () => createOpenAiCompatibleAdapter({ chatCompletionsUrl: "https://example.test/v1/chat/completions", apiKey: "k" }),
    temperatureOf: (b) => b.temperature,
    ok: { choices: [{ message: { content: "hi" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
  },
  {
    name: "google",
    make: () => createGoogleAdapter("k"),
    temperatureOf: (b) => (b.generationConfig as Record<string, unknown>).temperature,
    ok: { candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } },
  },
];

const PARAMS: AdapterParams = { temperature: 0, max_tokens: 100 };

describe.each(CASES)("$name adapter: what it sent", (c) => {
  const stub = (responses: { status: number; body: unknown }[]): { bodies: Record<string, unknown>[] } => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        const r = responses[Math.min(bodies.length - 1, responses.length - 1)];
        return { ok: r.status < 400, status: r.status, json: async () => r.body };
      }),
    );
    return { bodies };
  };

  it("sends the temperature and reports it", async () => {
    const { bodies } = stub([{ status: 200, body: c.ok }]);
    const r = await c.make()("model", "p", PARAMS);
    expect(c.temperatureOf(bodies[0])).toBe(0);
    expect(r.sent).toEqual({ temperature: 0 });
  });

  it("sends no temperature when asked to omit it, and reports the provider default", async () => {
    const { bodies } = stub([{ status: 200, body: c.ok }]);
    const r = await c.make()("model", "p", { ...PARAMS, omit_temperature: true });
    expect(c.temperatureOf(bodies[0])).toBeUndefined();
    expect(JSON.stringify(bodies[0])).not.toMatch(/temperature/i);
    expect(r.sent).toEqual({ temperature: "provider-default" });
    expect(r.deviations).toEqual([]);
  });

  it("after a provider rejects the temperature, retries without it, records the deviation, and reports the provider default", async () => {
    const { bodies } = stub([{ status: 400, body: { error: { message: "Unsupported value: temperature does not support 0" } } }, { status: 200, body: c.ok }]);
    const r = await c.make()("model", "p", PARAMS);
    expect(bodies).toHaveLength(2);
    expect(c.temperatureOf(bodies[1])).toBeUndefined();
    expect(r.sent).toEqual({ temperature: "provider-default" });
    expect(r.deviations.some((d) => /temperature forced to provider default/.test(d))).toBe(true);
  });
});
