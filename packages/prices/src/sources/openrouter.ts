const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface OpenRouterModel {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    [key: string]: string | undefined;
  };
  links?: { details?: string };
}

export interface OpenRouterEndpoint {
  provider_name: string;
  pricing: {
    prompt: string;
    completion: string;
    /** Cache-hit read rate, when this host publishes one separately — confirmed live 2026-09-25
     * against the real endpoints API for deepseek-v3.2 (DeepInfra, $0.13/1M) and
     * mistral-small-3.2-24b-instruct (Parasail, $0.05/1M), both cross-checked against each host's
     * own public pricing page. Optional: absent for a host with no separately-published cache
     * rate. */
    input_cache_read?: string;
    [key: string]: string | number | undefined;
  };
}

export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) {
    throw new Error(`OpenRouter models fetch failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: OpenRouterModel[] };
  return body.data;
}

/** Per-host offers for a single model — this is where "provider spread" comes from. */
export async function fetchOpenRouterEndpoints(modelId: string): Promise<OpenRouterEndpoint[]> {
  const res = await fetch(`${OPENROUTER_MODELS_URL}/${modelId}/endpoints`);
  if (!res.ok) {
    throw new Error(
      `OpenRouter endpoints fetch failed for ${modelId}: ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as { data: { endpoints: OpenRouterEndpoint[] } };
  return body.data.endpoints;
}
