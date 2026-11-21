import { describe, expect, it } from "vitest";
import { CHAT_LOOP_USAGE, callCostUsd, runRecordUsageConvention } from "./call-cost.js";

// The one place a call's dollar cost is computed from its token counts (docs/methodology.md, rules-2026-11-21). Every package prices calls here:
// the print, the demo agents, the MCP server, the gate-market testbed and cr-lab. Before this, four copies of the formula existed; the
// cached-token fix reached one of them.

// Gemini 3.1 Pro Preview's published list prices (prompts up to 200k tokens).
const GEMINI = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12", priceCachedInUsdPer1M: "0.2" };

describe("callCostUsd", () => {
  it("prices a prompt whose count includes its cached tokens once: the uncached part at the input rate, the cached part at the cached rate", () => {
    const usage = { input: 1_000_000, output: 0, cached_input: 430_000, reasoning: 0 };
    expect(callCostUsd(usage, GEMINI, { cachedInsideInput: true, reasoningInsideOutput: false }).toString()).toBe("1.226");
  });

  it("adds cached tokens reported apart from the prompt (Anthropic), so the same prompt costs the same", () => {
    const usage = { input: 570_000, output: 0, cached_input: 430_000, reasoning: 0 };
    expect(callCostUsd(usage, GEMINI, { cachedInsideInput: false, reasoningInsideOutput: true }).toString()).toBe("1.226");
  });

  it("prices the whole prompt at the input rate when no cached rate is published", () => {
    const usage = { input: 1_000_000, output: 0, cached_input: 430_000, reasoning: 0 };
    const noCachedRate = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };
    expect(callCostUsd(usage, noCachedRate, { cachedInsideInput: true, reasoningInsideOutput: false }).toString()).toBe("2");
  });

  it("adds reasoning tokens at the output rate only where the provider reports them apart from the output", () => {
    const usage = { input: 0, output: 100_000, cached_input: 0, reasoning: 50_000 };
    // Google and xAI report reasoning apart: 150k output tokens.
    expect(callCostUsd(usage, GEMINI, { cachedInsideInput: true, reasoningInsideOutput: false }).toString()).toBe("1.8");
    // OpenAI's completion_tokens and Anthropic's output_tokens already contain them: 100k.
    expect(callCostUsd(usage, GEMINI, { cachedInsideInput: true, reasoningInsideOutput: true }).toString()).toBe("1.2");
  });

  it("treats absent cached and reasoning counts as zero", () => {
    expect(callCostUsd({ input: 1_000, output: 500 }, GEMINI, { cachedInsideInput: true, reasoningInsideOutput: false }).toString()).toBe("0.008");
  });

  it("refuses a cached count larger than the prompt it is part of", () => {
    expect(() =>
      callCostUsd({ input: 100, output: 0, cached_input: 200 }, GEMINI, { cachedInsideInput: true, reasoningInsideOutput: false }),
    ).toThrow(/cached_input 200 exceeds input 100/);
  });

  it("never renders exponential notation, and loses no precision", () => {
    const usage = { input: 1, output: 1, cached_input: 0, reasoning: 0 };
    const tiny = { priceInUsdPer1M: "0.0000001", priceOutUsdPer1M: "0.0000003" };
    expect(callCostUsd(usage, tiny, { cachedInsideInput: true, reasoningInsideOutput: false }).toString()).toBe("0.0000000000004");
  });
});

describe("runRecordUsageConvention: how the harness adapters record usage", () => {
  it("Anthropic: cache reads apart from input_tokens; thinking tokens inside output_tokens", () => {
    expect(runRecordUsageConvention("anthropic")).toEqual({ cachedInsideInput: false, reasoningInsideOutput: true });
  });

  it("OpenAI: cached tokens inside prompt_tokens; reasoning tokens inside completion_tokens", () => {
    expect(runRecordUsageConvention("openai")).toEqual({ cachedInsideInput: true, reasoningInsideOutput: true });
  });

  it("Google and xAI: cached tokens inside the prompt count; reasoning reported apart (xAI checked against its billed figures)", () => {
    expect(runRecordUsageConvention("google")).toEqual({ cachedInsideInput: true, reasoningInsideOutput: false });
    expect(runRecordUsageConvention("xai")).toEqual({ cachedInsideInput: true, reasoningInsideOutput: false });
  });

  it("OpenRouter and the other OpenAI-compatible hosts: cached tokens inside prompt_tokens; reasoning as the print has always priced it", () => {
    for (const p of ["openrouter", "together", "fireworks", "groq"]) {
      expect(runRecordUsageConvention(p)).toEqual({ cachedInsideInput: true, reasoningInsideOutput: false });
    }
  });

  it("refuses a provider it has no stated convention for", () => {
    expect(() => runRecordUsageConvention("acme")).toThrow(/acme/);
  });
});

describe("CHAT_LOOP_USAGE: cr-lab's own chat loops", () => {
  it("take cached tokens out of the prompt and leave reasoning inside the output, for both providers", () => {
    expect(CHAT_LOOP_USAGE).toEqual({ cachedInsideInput: false, reasoningInsideOutput: true });
  });
});
