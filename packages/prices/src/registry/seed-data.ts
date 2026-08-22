/**
 * The declarative "intent" for the 12-entry model registry (build1-spec.md §4, per P5):
 * three frontier models, three mid-tier models (all native — Anthropic/OpenAI/Google,
 * resolved at runtime, see resolve-native-models.ts), one open-weight model served by
 * three different hosts (provider-spread demo), and three further open-weight models
 * for catalog breadth. That's 3 + 3 + 3 + 3 = 12; the brief's "two others" undercounts
 * by one against its own stated total of 12, so a third "other" was added to reconcile it.
 *
 * Everything below is a stable identifier (an OpenRouter model slug, not a dated version
 * string), so none of it goes stale the way a hardcoded "claude-sonnet-20250219" would.
 */

export const OPENROUTER_CHAT_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterHostIntent {
  registry_id: string;
  openrouter_model_id: string;
  /** Must match an endpoint's provider_name from fetchOpenRouterEndpoints exactly. */
  host_provider_name: string;
  host: string;
  tier: "mid" | "open-weight-hosted";
  notes: string;
}

const LLAMA_3_3_70B = "meta-llama/llama-3.3-70b-instruct";

export const OPEN_WEIGHT_MULTI_HOST_INTENT: OpenRouterHostIntent[] = [
  {
    registry_id: "llama-3.3-70b-deepinfra",
    openrouter_model_id: LLAMA_3_3_70B,
    host_provider_name: "DeepInfra",
    host: "deepinfra",
    tier: "open-weight-hosted",
    notes: "Provider-spread demo: same weights as llama-3.3-70b-novita/cloudflare.",
  },
  {
    registry_id: "llama-3.3-70b-novita",
    openrouter_model_id: LLAMA_3_3_70B,
    host_provider_name: "Novita",
    host: "novita",
    tier: "open-weight-hosted",
    notes: "Provider-spread demo: same weights as llama-3.3-70b-deepinfra/cloudflare.",
  },
  {
    registry_id: "llama-3.3-70b-cloudflare",
    openrouter_model_id: LLAMA_3_3_70B,
    host_provider_name: "Cloudflare",
    host: "cloudflare",
    tier: "open-weight-hosted",
    notes: "Provider-spread demo: same weights as llama-3.3-70b-deepinfra/novita.",
  },
];

export const OTHER_OPEN_WEIGHT_INTENT: OpenRouterHostIntent[] = [
  {
    registry_id: "deepseek-v3.2",
    openrouter_model_id: "deepseek/deepseek-v3.2",
    host_provider_name: "DeepInfra",
    host: "deepinfra",
    tier: "open-weight-hosted",
    notes: "Catalog breadth: distinct model family from the Llama provider-spread trio.",
  },
  {
    registry_id: "qwen-2.5-72b-instruct",
    openrouter_model_id: "qwen/qwen-2.5-72b-instruct",
    host_provider_name: "DeepInfra",
    host: "deepinfra",
    tier: "open-weight-hosted",
    notes:
      "Catalog breadth: distinct model family from the Llama provider-spread trio. Was pinned " +
      "to novita, which structurally rejects this model on the completions endpoint (HTTP 400, " +
      "not congestion) — OpenRouter serves it from exactly two providers, deepinfra and novita, " +
      "and only deepinfra actually works. Corrected before the first real print run.",
  },
  {
    registry_id: "mistral-small-3.2-24b-instruct",
    openrouter_model_id: "mistralai/mistral-small-3.2-24b-instruct",
    host_provider_name: "Parasail",
    host: "parasail",
    tier: "open-weight-hosted",
    notes: "Cheapest-tier contrast point in the registry.",
  },
];
