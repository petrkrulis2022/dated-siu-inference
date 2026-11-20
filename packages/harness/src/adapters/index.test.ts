import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdapterFor } from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PARAMS = { temperature: 0 as const, max_tokens: 10 };

function captureBody(): { body: () => Record<string, unknown> | undefined } {
  let captured: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      captured = JSON.parse(init.body as string);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
    }),
  );
  return { body: () => captured };
}

describe("createAdapterFor: OpenRouter requests", () => {
  // OpenRouter's docs: priority endpoints of open-weight models compete for default traffic and match their base slug, so a provider.only pin
  // alone does not keep a call off the priority tier (17 of 60 calls pinned to deepinfra/fp8 were served and billed on it, 18-20 Nov). A
  // top-level service_tier of "default" keeps them out of the pool. The tier is part of the declared purchase path (rules-2026-11-20).
  it("pins the call to the exact endpoint and asks for the declared standard tier", async () => {
    const { body } = captureBody();
    const adapter = createAdapterFor({ provider: "openrouter", host: "deepinfra/fp8", service_tier: "default" }, { openrouter: "k" });
    await adapter("mistralai/mistral-small-3.2-24b-instruct", "prompt", PARAMS);
    expect(body()?.provider).toEqual({ only: ["deepinfra/fp8"] });
    expect(body()?.service_tier).toBe("default");
  });

  it("asks for no tier when an entry declares none (Parasail: a call with service_tier got a 429, the same call without it succeeded)", async () => {
    const { body } = captureBody();
    const adapter = createAdapterFor({ provider: "openrouter", host: "parasail" }, { openrouter: "k" });
    await adapter("mistralai/mistral-small-3.2-24b-instruct", "prompt", PARAMS);
    expect(body()?.provider).toEqual({ only: ["parasail"] });
    expect(body()).not.toHaveProperty("service_tier");
  });

  it("still asks for the declared tier on a demo call allowed to route unpinned", async () => {
    const { body } = captureBody();
    const adapter = createAdapterFor(
      { provider: "openrouter", host: "deepinfra/fp8", service_tier: "default" },
      { openrouter: "k" },
      { allowUnpinnedRouting: true },
    );
    await adapter("mistralai/mistral-small-3.2-24b-instruct", "prompt", PARAMS);
    expect(body()).not.toHaveProperty("provider");
    expect(body()?.service_tier).toBe("default");
  });

  it("sends no service_tier to a provider other than OpenRouter", async () => {
    const { body } = captureBody();
    const adapter = createAdapterFor({ provider: "xai", host: "xai" }, { xai: "k" });
    await adapter("grok-4.6", "prompt", PARAMS);
    expect(body()).not.toHaveProperty("service_tier");
  });
});
