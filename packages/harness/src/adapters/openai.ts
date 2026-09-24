import {
  AdapterHttpError,
  REASONING_BUDGET_MULTIPLE,
  type Adapter,
  type AdapterParams,
  type AdapterResult,
} from "./types.js";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

interface OpenAiResponse {
  choices: { message: { content: string }; finish_reason?: string }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

async function callOpenAi(
  apiKey: string,
  modelString: string,
  prompt: string,
  params: AdapterParams,
  includeTemperature: boolean,
  maxCompletionTokens: number,
): Promise<{ response: OpenAiResponse; latencyMs: number }> {
  const body: Record<string, unknown> = {
    model: modelString,
    max_completion_tokens: maxCompletionTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (includeTemperature) {
    body.temperature = params.temperature;
  }

  const start = Date.now();
  const res = await fetch(OPENAI_CHAT_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorBody = await res.json().catch(() => undefined);
    throw new AdapterHttpError(`OpenAI request failed: ${res.status}`, res.status, errorBody);
  }

  return { response: (await res.json()) as OpenAiResponse, latencyMs };
}

function mentionsTemperature(err: unknown): boolean {
  return (
    err instanceof AdapterHttpError &&
    err.status === 400 &&
    /temperature/i.test(JSON.stringify(err.body))
  );
}

export function createOpenAiAdapter(apiKey: string): Adapter {
  return async (modelString, prompt, params) => {
    const deviations: string[] = [];
    let result: { response: OpenAiResponse; latencyMs: number };
    // Reused for the reasoning-truncation retry below — see anthropic.ts's identical fix and its
    // doc comment for the real failure this closes: that retry must not resend `temperature` once
    // the first call has already established the model rejects it.
    let includeTemperature = true;
    try {
      result = await callOpenAi(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      includeTemperature = false;
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callOpenAi(apiKey, modelString, prompt, params, false, params.max_tokens);
    }

    // Same architectural rule as google.ts's createGoogleAdapter — see its doc comment. Applies
    // uniformly to any provider reporting reasoning tokens separately whose completion was cut
    // off by the task budget with reasoning already consuming part of it; a no-op for a call
    // that didn't hit this (finish_reason "length" only fires on a real truncation).
    const truncatedResult = result;
    const truncatedByReasoning =
      truncatedResult.response.choices[0]?.finish_reason === "length" &&
      (truncatedResult.response.usage.completion_tokens_details?.reasoning_tokens ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (finish_reason length, ` +
          `${truncatedResult.response.usage.completion_tokens_details?.reasoning_tokens} reasoning tokens ` +
          `against a ${params.max_tokens}-token task budget) — retried with reasoning accommodated ` +
          `above the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callOpenAi(apiKey, modelString, prompt, params, includeTemperature, accommodatedBudget);
    }

    const { response, latencyMs } = result;
    // Same real-cost fix as google.ts: the truncated first call is a real, separately-billed
    // request whose own usage must be summed in, not discarded — see google.ts's comment for the
    // full reasoning.
    const truncatedUsage = truncatedByReasoning ? truncatedResult.response.usage : undefined;
    const adapterResult: AdapterResult = {
      text: response.choices[0]?.message.content ?? "",
      usage: {
        input: response.usage.prompt_tokens + (truncatedUsage?.prompt_tokens ?? 0),
        output: response.usage.completion_tokens + (truncatedUsage?.completion_tokens ?? 0),
        cached_input:
          (response.usage.prompt_tokens_details?.cached_tokens ?? 0) +
          (truncatedUsage?.prompt_tokens_details?.cached_tokens ?? 0),
        reasoning:
          (response.usage.completion_tokens_details?.reasoning_tokens ?? 0) +
          (truncatedUsage?.completion_tokens_details?.reasoning_tokens ?? 0),
      },
      latency_ms: latencyMs,
      raw: truncatedByReasoning ? { truncated: truncatedResult.response, final: response } : response,
      deviations,
    };
    return adapterResult;
  };
}
