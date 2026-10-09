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

describe("validateModelRegistryEntry: sampling", () => {
  const base = { id: "m", provider: "p", endpoint: "https://e.test", model_string: "m", tier: "mid", open_weights: true, host: "h" };
  it("accepts a number or \"provider-default\" and no declaration at all", () => {
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: 0 } }).valid).toBe(true);
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: 0.3 } }).valid).toBe(true);
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: "provider-default" } }).valid).toBe(true);
    expect(validateModelRegistryEntry(base).valid).toBe(true);
  });
  it("rejects a negative temperature, another word, a missing temperature, and an unknown key", () => {
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: -1 } }).valid).toBe(false);
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: "default" } }).valid).toBe(false);
    expect(validateModelRegistryEntry({ ...base, sampling: {} }).valid).toBe(false);
    expect(validateModelRegistryEntry({ ...base, sampling: { temperature: 0, top_p: 1 } }).valid).toBe(false);
  });
});
