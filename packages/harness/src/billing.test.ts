import { describe, expect, it } from "vitest";
import { billingFromRaw } from "./billing.js";

describe("billingFromRaw", () => {
  it("reads OpenRouter's service tier and billed cost (usage.cost) from the response", () => {
    expect(
      billingFromRaw({
        provider: "DeepInfra",
        service_tier: "priority",
        usage: { prompt_tokens: 21958, completion_tokens: 49, cost: 0.00248685 },
      }),
    ).toEqual({ service_tier: "priority", billed_usd: "0.00248685" });
  });

  it("writes a billed cost the response gives in exponent form as a plain decimal string", () => {
    expect(billingFromRaw({ service_tier: "default", usage: { cost: 7.138e-5 } })).toEqual({
      service_tier: "default",
      billed_usd: "0.00007138",
    });
  });

  it("records a null tier when an OpenRouter response names none (Parasail)", () => {
    expect(billingFromRaw({ provider: "Parasail", usage: { cost: 0.000467 } })).toEqual({
      service_tier: null,
      billed_usd: "0.000467",
    });
  });

  it("reads xAI's billed cost in ticks of 1e-10 USD", () => {
    expect(billingFromRaw({ service_tier: "default", usage: { cost_in_usd_ticks: 20140000 } })).toEqual({
      service_tier: "default",
      billed_usd: "0.002014",
    });
  });

  it("reads Anthropic's tier from usage and reports no billed cost, since none is in the response", () => {
    expect(billingFromRaw({ usage: { input_tokens: 10, output_tokens: 2, service_tier: "standard" } })).toEqual({
      service_tier: "standard",
    });
  });

  it("reads Google's tier from usageMetadata, including the truncated-then-final wrapper", () => {
    expect(billingFromRaw({ usageMetadata: { serviceTier: "standard" } })).toEqual({ service_tier: "standard" });
    expect(
      billingFromRaw({
        truncated: { usageMetadata: { serviceTier: "standard" } },
        final: { usageMetadata: { serviceTier: "standard" } },
      }),
    ).toEqual({ service_tier: "standard" });
  });

  it("sums the billed cost of both calls in a truncated-then-final wrapper, and takes the final call's tier", () => {
    expect(
      billingFromRaw({
        truncated: { service_tier: "default", usage: { cost: 0.001 } },
        final: { service_tier: "priority", usage: { cost: 0.0025 } },
      }),
    ).toEqual({ service_tier: "priority", billed_usd: "0.0035" });
  });

  it("leaves billed_usd out rather than guess when the figure is not a finite, non-negative number", () => {
    for (const cost of [-1, Number.NaN, "0.001", null]) {
      expect(billingFromRaw({ service_tier: "default", usage: { cost } })).toEqual({ service_tier: "default" });
    }
    expect(billingFromRaw({ usage: { cost_in_usd_ticks: 1.5 } })).toEqual({ service_tier: null });
  });

  it("reports a null tier for a response with nothing recognisable in it", () => {
    expect(billingFromRaw({ some: "raw payload" })).toEqual({ service_tier: null });
    expect(billingFromRaw(undefined)).toEqual({ service_tier: null });
  });
});
