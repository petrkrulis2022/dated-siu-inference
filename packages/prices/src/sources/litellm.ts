const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface LiteLLMEntry {
  litellm_provider?: string;
  mode?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  /** Cache-hit read rate, when this model publishes one separately — e.g. Gemini 3.1 Pro
   * Preview's real $0.20/1M cached-input rate (confirmed live against ai.google.dev/gemini-api/
   * docs/pricing, 2026-09-13), independent of the ≤200k-tier field name here which only ever
   * carries the ≤200k rate — see build-snapshot.ts's own comment on why the >200k tier isn't
   * captured. */
  cache_read_input_token_cost?: number;
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
