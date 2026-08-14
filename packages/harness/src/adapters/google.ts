import { AdapterHttpError, type Adapter, type AdapterParams, type AdapterResult } from "./types.js";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleResponse {
  candidates: { content: { parts: { text?: string }[] } }[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

async function callGoogle(
  apiKey: string,
  modelString: string,
  prompt: string,
  params: AdapterParams,
  includeTemperature: boolean,
): Promise<{ response: GoogleResponse; latencyMs: number }> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens: params.max_tokens };
  if (includeTemperature) {
    generationConfig.temperature = params.temperature;
  }

  const start = Date.now();
  const res = await fetch(
    `${GOOGLE_BASE_URL}/models/${modelString}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig,
      }),
    },
  );
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorBody = await res.json().catch(() => undefined);
    throw new AdapterHttpError(`Google request failed: ${res.status}`, res.status, errorBody);
  }

  return { response: (await res.json()) as GoogleResponse, latencyMs };
}

function mentionsTemperature(err: unknown): boolean {
  return (
    err instanceof AdapterHttpError &&
    err.status === 400 &&
    /temperature/i.test(JSON.stringify(err.body))
  );
}

export function createGoogleAdapter(apiKey: string): Adapter {
  return async (modelString, prompt, params) => {
    const deviations: string[] = [];
    let result: { response: GoogleResponse; latencyMs: number };
    try {
      result = await callGoogle(apiKey, modelString, prompt, params, true);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callGoogle(apiKey, modelString, prompt, params, false);
    }

    const { response, latencyMs } = result;
    const text = (response.candidates[0]?.content.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    const adapterResult: AdapterResult = {
      text,
      usage: {
        input: response.usageMetadata.promptTokenCount,
        output: response.usageMetadata.candidatesTokenCount,
        cached_input: response.usageMetadata.cachedContentTokenCount ?? 0,
        reasoning: response.usageMetadata.thoughtsTokenCount ?? 0,
      },
      latency_ms: latencyMs,
      raw: response,
      deviations,
    };
    return adapterResult;
  };
}
