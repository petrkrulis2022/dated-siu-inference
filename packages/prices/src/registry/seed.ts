import { readFile, writeFile } from "node:fs/promises";
import type { ModelRegistryEntry } from "@touchstone/sdk";
import { validateModelRegistryEntry } from "@touchstone/sdk";
import { fetchOpenRouterEndpoints } from "../sources/openrouter.js";
import {
  resolveAnthropicModels,
  resolveGoogleModels,
  resolveOpenAiModels,
} from "./resolve-native-models.js";
import {
  OPENROUTER_CHAT_ENDPOINT,
  OPEN_WEIGHT_MULTI_HOST_INTENT,
  OTHER_OPEN_WEIGHT_INTENT,
  type OpenRouterHostIntent,
} from "./seed-data.js";

export interface SeedResult {
  entries: ModelRegistryEntry[];
  skipped: { registry_id: string; reason: string }[];
}

async function resolveOpenRouterIntent(intent: OpenRouterHostIntent): Promise<ModelRegistryEntry> {
  const endpoints = await fetchOpenRouterEndpoints(intent.openrouter_model_id);
  const match = endpoints.find((e) => e.provider_name === intent.host_provider_name);
  if (!match) {
    throw new Error(
      `No OpenRouter endpoint named "${intent.host_provider_name}" for ${intent.openrouter_model_id}. ` +
        `Available: ${endpoints.map((e) => e.provider_name).join(", ")}`,
    );
  }
  return {
    id: intent.registry_id,
    provider: "openrouter",
    endpoint: OPENROUTER_CHAT_ENDPOINT,
    model_string: intent.openrouter_model_id,
    tier: intent.tier,
    open_weights: true,
    host: intent.host,
    notes: intent.notes,
  };
}

async function resolveNativeEntries(): Promise<{
  entries: ModelRegistryEntry[];
  skipped: { registry_id: string; reason: string }[];
}> {
  const entries: ModelRegistryEntry[] = [];
  const skipped: { registry_id: string; reason: string }[] = [];

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const { frontier, mid } = await resolveAnthropicModels(anthropicKey);
    entries.push(
      {
        id: "anthropic-frontier",
        provider: "anthropic",
        endpoint: "https://api.anthropic.com/v1/messages",
        model_string: frontier,
        tier: "frontier",
        open_weights: false,
        host: "anthropic",
        notes: "Resolved at runtime from /v1/models — never hardcoded.",
      },
      {
        id: "anthropic-mid",
        provider: "anthropic",
        endpoint: "https://api.anthropic.com/v1/messages",
        model_string: mid,
        tier: "mid",
        open_weights: false,
        host: "anthropic",
        notes: "Resolved at runtime from /v1/models — never hardcoded.",
      },
    );
  } else {
    skipped.push(
      { registry_id: "anthropic-frontier", reason: "ANTHROPIC_API_KEY not set" },
      { registry_id: "anthropic-mid", reason: "ANTHROPIC_API_KEY not set" },
    );
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    const { frontier, mid } = await resolveOpenAiModels(openaiKey);
    entries.push(
      {
        id: "openai-frontier",
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model_string: frontier,
        tier: "frontier",
        open_weights: false,
        host: "openai",
        notes: "Resolved at runtime from /v1/models — never hardcoded.",
      },
      {
        id: "openai-mid",
        provider: "openai",
        endpoint: "https://api.openai.com/v1/chat/completions",
        model_string: mid,
        tier: "mid",
        open_weights: false,
        host: "openai",
        notes: "Resolved at runtime from /v1/models — never hardcoded.",
      },
    );
  } else {
    skipped.push(
      { registry_id: "openai-frontier", reason: "OPENAI_API_KEY not set" },
      { registry_id: "openai-mid", reason: "OPENAI_API_KEY not set" },
    );
  }

  const googleKey = process.env.GOOGLE_API_KEY;
  if (googleKey) {
    const { frontier, mid } = await resolveGoogleModels(googleKey);
    entries.push(
      {
        id: "google-frontier",
        provider: "google",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model_string: frontier,
        tier: "frontier",
        open_weights: false,
        host: "google",
        notes: "Resolved at runtime from ListModels — never hardcoded.",
      },
      {
        id: "google-mid",
        provider: "google",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
        model_string: mid,
        tier: "mid",
        open_weights: false,
        host: "google",
        notes: "Resolved at runtime from ListModels — never hardcoded.",
      },
    );
  } else {
    skipped.push(
      { registry_id: "google-frontier", reason: "GOOGLE_API_KEY not set" },
      { registry_id: "google-mid", reason: "GOOGLE_API_KEY not set" },
    );
  }

  return { entries, skipped };
}

export async function seedRegistry(): Promise<SeedResult> {
  const openRouterIntents = [...OPEN_WEIGHT_MULTI_HOST_INTENT, ...OTHER_OPEN_WEIGHT_INTENT];
  const openRouterEntries = await Promise.all(openRouterIntents.map(resolveOpenRouterIntent));
  const native = await resolveNativeEntries();

  const entries = [...native.entries, ...openRouterEntries];
  for (const entry of entries) {
    const result = validateModelRegistryEntry(entry);
    if (!result.valid) {
      throw new Error(
        `Registry entry "${entry.id}" failed schema validation: ${result.errors.join("; ")}`,
      );
    }
  }

  return { entries, skipped: native.skipped };
}

/** Merges newly-resolved entries into any existing registry file, keyed by id. Idempotent. */
export async function writeRegistry(
  registryPath: string,
  entries: ModelRegistryEntry[],
): Promise<void> {
  let existing: ModelRegistryEntry[] = [];
  try {
    existing = JSON.parse(await readFile(registryPath, "utf-8"));
  } catch {
    // No existing file yet — that's fine, start fresh.
  }

  const byId = new Map(existing.map((e) => [e.id, e]));
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }

  const merged = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(registryPath, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}
