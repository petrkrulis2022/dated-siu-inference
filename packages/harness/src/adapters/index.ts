import type { ModelRegistryEntry } from "@touchstone/sdk";
import { createAnthropicAdapter } from "./anthropic.js";
import { createOpenAiAdapter } from "./openai.js";
import { createGoogleAdapter } from "./google.js";
import { createOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_HOSTS } from "./openai-compatible.js";
import type { Adapter } from "./types.js";

export * from "./types.js";
export { createAnthropicAdapter } from "./anthropic.js";
export { createOpenAiAdapter } from "./openai.js";
export { createGoogleAdapter } from "./google.js";
export { createOpenAiCompatibleAdapter, OPENAI_COMPATIBLE_HOSTS } from "./openai-compatible.js";

export interface ApiKeys {
  anthropic?: string;
  openai?: string;
  google?: string;
  openrouter?: string;
  together?: string;
  fireworks?: string;
  groq?: string;
}

export function loadApiKeysFromEnv(): ApiKeys {
  return {
    anthropic: process.env.ANTHROPIC_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
    together: process.env.TOGETHER_API_KEY,
    fireworks: process.env.FIREWORKS_API_KEY,
    groq: process.env.GROQ_API_KEY,
  };
}

function requireKey(keys: ApiKeys, provider: keyof ApiKeys, envVar: string): string {
  const key = keys[provider];
  if (!key) {
    throw new Error(`No adapter for provider "${provider}": ${envVar} not set`);
  }
  return key;
}

/**
 * Resolves the adapter for a registry entry (§4's four adapter families). Takes the full
 * entry, not just `provider` — an OpenRouter-routed entry needs its `host` field to pin the
 * request to that specific underlying host via OpenRouter's `provider.only` routing hint;
 * without it, OpenRouter auto-routes and the registry's multi-host provider-spread entries
 * would all silently converge on whichever host OpenRouter picks.
 *
 * Note: `entry.host` is stored lowercased (e.g. "deepinfra"); OpenRouter's own provider slugs
 * are capitalized (e.g. "DeepInfra"). This assumes OpenRouter matches `provider.only`
 * case-insensitively — unverified against a live call, since no OpenRouter key is available
 * in this environment. Worth confirming against a real response once one is.
 */
export function createAdapterFor(
  entry: Pick<ModelRegistryEntry, "provider" | "host">,
  keys: ApiKeys,
): Adapter {
  switch (entry.provider) {
    case "anthropic":
      return createAnthropicAdapter(requireKey(keys, "anthropic", "ANTHROPIC_API_KEY"));
    case "openai":
      return createOpenAiAdapter(requireKey(keys, "openai", "OPENAI_API_KEY"));
    case "google":
      return createGoogleAdapter(requireKey(keys, "google", "GOOGLE_API_KEY"));
    case "openrouter":
      return createOpenAiCompatibleAdapter({
        chatCompletionsUrl: OPENAI_COMPATIBLE_HOSTS.openrouter,
        apiKey: requireKey(keys, "openrouter", "OPENROUTER_API_KEY"),
        extraBody: { provider: { only: [entry.host] } },
      });
    case "together":
      return createOpenAiCompatibleAdapter({
        chatCompletionsUrl: OPENAI_COMPATIBLE_HOSTS.together,
        apiKey: requireKey(keys, "together", "TOGETHER_API_KEY"),
      });
    case "fireworks":
      return createOpenAiCompatibleAdapter({
        chatCompletionsUrl: OPENAI_COMPATIBLE_HOSTS.fireworks,
        apiKey: requireKey(keys, "fireworks", "FIREWORKS_API_KEY"),
      });
    case "groq":
      return createOpenAiCompatibleAdapter({
        chatCompletionsUrl: OPENAI_COMPATIBLE_HOSTS.groq,
        apiKey: requireKey(keys, "groq", "GROQ_API_KEY"),
      });
    default:
      throw new Error(`No adapter for provider "${entry.provider}".`);
  }
}
