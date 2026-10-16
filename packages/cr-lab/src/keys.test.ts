import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import {
  BLOCKWORKS_KEY_NAME,
  MissingKeyError,
  PROVIDERS,
  Secret,
  TRIAL_KEY_NAMES,
  blockworksKey,
  missingTrialKeys,
  providersWithKeys,
  redactTrialSecrets,
  trialKey,
} from "./keys.js";

const VALUE = "sk-trial-0123456789abcdef";

describe("trial keys", () => {
  it("names one CR_ variable per provider, all different, all starting CR_", () => {
    expect(PROVIDERS).toEqual(["anthropic", "openai", "google", "xai", "openrouter"]);
    expect(new Set(Object.values(TRIAL_KEY_NAMES)).size).toBe(5);
    for (const n of [...Object.values(TRIAL_KEY_NAMES), BLOCKWORKS_KEY_NAME])
      expect(n).toMatch(/^CR_[A-Z]+_API_KEY$/);
  });

  it("reads the trial key, trimmed", () => {
    const k = trialKey("anthropic", { CR_ANTHROPIC_API_KEY: `  ${VALUE}\n` });
    expect(k.reveal()).toBe(VALUE);
    expect(k.name).toBe("CR_ANTHROPIC_API_KEY");
  });

  it("NEVER falls back to the print's key: with only the print's key set, it throws, naming the trial variable and not any value", () => {
    const env = {
      ANTHROPIC_API_KEY: "print-key-should-not-be-used-0000",
      OPENAI_API_KEY: "print-openai-0000000000",
    };
    for (const p of PROVIDERS) expect(() => trialKey(p, env)).toThrow(MissingKeyError);
    try {
      trialKey("anthropic", env);
    } catch (err) {
      expect((err as Error).message).toContain("CR_ANTHROPIC_API_KEY");
      expect((err as Error).message).not.toContain("print-key-should-not-be-used");
    }
    expect(providersWithKeys(env)).toEqual([]);
  });

  it("treats an empty or whitespace value as unset, as .env holds before a key is pasted", () => {
    expect(() => trialKey("google", { CR_GOOGLE_API_KEY: "" })).toThrow(MissingKeyError);
    expect(() => trialKey("google", { CR_GOOGLE_API_KEY: "   " })).toThrow(MissingKeyError);
    expect(missingTrialKeys({ CR_GOOGLE_API_KEY: "", CR_XAI_API_KEY: VALUE })).toEqual([
      "CR_ANTHROPIC_API_KEY",
      "CR_OPENAI_API_KEY",
      "CR_GOOGLE_API_KEY",
      "CR_OPENROUTER_API_KEY",
    ]);
    expect(providersWithKeys({ CR_XAI_API_KEY: VALUE, CR_OPENAI_API_KEY: VALUE })).toEqual([
      "openai",
      "xai",
    ]);
  });

  it("reads the Blockworks key under its own name, and throws if unset", () => {
    expect(blockworksKey({ CR_BLOCKWORKS_API_KEY: VALUE }).reveal()).toBe(VALUE);
    expect(() => blockworksKey({})).toThrow(/CR_BLOCKWORKS_API_KEY/);
  });
});

describe("Secret cannot leak by accident", () => {
  const s = new Secret("CR_OPENAI_API_KEY", VALUE);

  it("prints, serialises and inspects as a placeholder", () => {
    expect(`${s}`).toBe("[redacted CR_OPENAI_API_KEY]");
    expect(String(s)).not.toContain(VALUE);
    expect(JSON.stringify({ key: s })).not.toContain(VALUE);
    expect(inspect(s)).not.toContain(VALUE);
    expect(inspect({ nested: { s } }, { depth: 5 })).not.toContain(VALUE);
    expect(Object.values(s).join("")).not.toContain(VALUE);
    expect(Object.keys(s)).toEqual(["name"]);
  });

  it("gives the value only through reveal()", () => {
    expect(s.reveal()).toBe(VALUE);
  });
});

describe("redactTrialSecrets", () => {
  it("removes every CR_ value from a message, wherever it appears, and leaves other text alone", () => {
    const env = {
      CR_ANTHROPIC_API_KEY: VALUE,
      CR_XAI_API_KEY: "xai-0123456789abcdefgh",
      UNRELATED: "keep-this-value",
    };
    const text = `request failed: https://api.example/v1?key=${VALUE} and header xai-0123456789abcdefgh (keep-this-value)`;
    const out = redactTrialSecrets(text, env);
    expect(out).not.toContain(VALUE);
    expect(out).not.toContain("xai-0123456789abcdefgh");
    expect(out).toContain("[redacted CR_ANTHROPIC_API_KEY]");
    expect(out).toContain("keep-this-value");
  });

  it("leaves very short values alone rather than mangling the text", () => {
    expect(redactTrialSecrets("a b c abc", { CR_XAI_API_KEY: "abc" })).toBe("a b c abc");
  });
});
