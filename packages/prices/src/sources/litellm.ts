const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_input_tokens?: number;
  max_output_tokens?: number;
  [key: string]: unknown;
}

/** Keyed by LiteLLM's own model key, e.g. "gpt-4o", "anthropic.claude-sonnet-5". */
export type LiteLLMPriceMap = Record<string, LiteLLMEntry>;

export async function fetchLiteLLMPrices(): Promise<LiteLLMPriceMap> {
  const res = await fetch(LITELLM_PRICES_URL);
  if (!res.ok) {
    throw new Error(`LiteLLM price map fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as LiteLLMPriceMap;
  // "sample_spec" documents the field shapes, it isn't a real model entry.
  return Object.fromEntries(Object.entries(body).filter(([key]) => key !== "sample_spec"));
}
