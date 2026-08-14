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
