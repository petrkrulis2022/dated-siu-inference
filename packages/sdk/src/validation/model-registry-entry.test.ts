import { describe, expect, it } from "vitest";
import { validateModelRegistryEntry } from "./model-registry-entry.js";

describe("validateModelRegistryEntry", () => {
  it("accepts a valid entry", () => {
    const result = validateModelRegistryEntry({
      id: "anthropic-sonnet-5",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model_string: "claude-sonnet-5",
      tier: "frontier",
      open_weights: false,
      host: "anthropic",
      notes: "primary frontier reference model",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects an entry missing a required field", () => {
    const result = validateModelRegistryEntry({
      id: "anthropic-sonnet-5",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model_string: "claude-sonnet-5",
      tier: "frontier",
      open_weights: false,
      // host omitted
    });
    expect(result.valid).toBe(false);
  });

  it("rejects an entry with an out-of-enum tier", () => {
    const result = validateModelRegistryEntry({
      id: "anthropic-sonnet-5",
      provider: "anthropic",
      endpoint: "https://api.anthropic.com/v1/messages",
      model_string: "claude-sonnet-5",
      tier: "premium",
      open_weights: false,
      host: "anthropic",
    });
    expect(result.valid).toBe(false);
  });
});
