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
    try {
      result = await callOpenAi(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callOpenAi(apiKey, modelString, prompt, params, false, params.max_tokens);
    }

    // Same architectural rule as google.ts's createGoogleAdapter — see its doc comment. Applies
    // uniformly to any provider reporting reasoning tokens separately whose completion was cut
    // off by the task budget with reasoning already consuming part of it; a no-op for a call
    // that didn't hit this (finish_reason "length" only fires on a real truncation).
    const truncatedByReasoning =
      result.response.choices[0]?.finish_reason === "length" &&
      (result.response.usage.completion_tokens_details?.reasoning_tokens ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (finish_reason length, ` +
          `${result.response.usage.completion_tokens_details?.reasoning_tokens} reasoning tokens ` +
          `against a ${params.max_tokens}-token task budget) — retried with reasoning accommodated ` +
          `above the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callOpenAi(apiKey, modelString, prompt, params, true, accommodatedBudget);
    }

    const { response, latencyMs } = result;
    const adapterResult: AdapterResult = {
      text: response.choices[0]?.message.content ?? "",
      usage: {
        input: response.usage.prompt_tokens,
        output: response.usage.completion_tokens,
        cached_input: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoning: response.usage.completion_tokens_details?.reasoning_tokens ?? 0,
      },
      latency_ms: latencyMs,
      raw: response,
      deviations,
    };
    return adapterResult;
  };
}
