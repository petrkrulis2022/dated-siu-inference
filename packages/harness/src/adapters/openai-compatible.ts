import { AdapterHttpError, type Adapter, type AdapterParams, type AdapterResult } from "./types.js";

interface OpenAiCompatibleResponse {
  choices: { message: { content: string } }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    completion_tokens_details?: { reasoning_tokens?: number };
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export interface OpenAiCompatibleConfig {
  /** e.g. "https://openrouter.ai/api/v1/chat/completions" */
  chatCompletionsUrl: string;
  apiKey: string;
  /** Extra headers a specific host requires beyond Authorization, e.g. OpenRouter's referer. */
  extraHeaders?: Record<string, string>;
  /**
   * Extra body fields merged into every request — used for OpenRouter's `provider.only`
   * routing hint, which pins a call to one specific underlying host. Without it, OpenRouter
   * auto-routes to whichever host it likes, which would silently erase the provider-spread
   * distinction the registry's multi-host entries exist to measure.
   */
  extraBody?: Record<string, unknown>;
}

async function callOpenAiCompatible(
  config: OpenAiCompatibleConfig,
  modelString: string,
  prompt: string,
  params: AdapterParams,
  includeTemperature: boolean,
): Promise<{ response: OpenAiCompatibleResponse; latencyMs: number }> {
  const body: Record<string, unknown> = {
    model: modelString,
    max_tokens: params.max_tokens,
    messages: [{ role: "user", content: prompt }],
    ...config.extraBody,
  };
  if (includeTemperature) {
    body.temperature = params.temperature;
  }

  const start = Date.now();
  const res = await fetch(config.chatCompletionsUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      ...config.extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorBody = await res.json().catch(() => undefined);
    throw new AdapterHttpError(
      `OpenAI-compatible request failed: ${res.status}`,
      res.status,
      errorBody,
    );
  }

  return { response: (await res.json()) as OpenAiCompatibleResponse, latencyMs };
}

function mentionsTemperature(err: unknown): boolean {
  return (
    err instanceof AdapterHttpError &&
    err.status === 400 &&
    /temperature/i.test(JSON.stringify(err.body))
  );
}

/** Same wire format across OpenRouter, Together, Fireworks, Groq, and xAI — one adapter, five
 * configs. */
export function createOpenAiCompatibleAdapter(config: OpenAiCompatibleConfig): Adapter {
  return async (modelString, prompt, params) => {
    const deviations: string[] = [];
    let result: { response: OpenAiCompatibleResponse; latencyMs: number };
    try {
      result = await callOpenAiCompatible(config, modelString, prompt, params, true);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callOpenAiCompatible(config, modelString, prompt, params, false);
    }

    const { response, latencyMs } = result;
    const reasoningTokens = response.usage.completion_tokens_details?.reasoning_tokens ?? 0;
    // Confirmed live against xAI's grok-4.6 (2026-09-08): reasoning_effort:"none" is explicitly
    // rejected ("This model does not support `reasoning_effort` value `none`") — mandatory,
    // cannot be disabled, the same category build1-spec.md §3 already names ("reasoning models
    // that cannot run at temperature 0"). Recorded generically here (any OpenAI-compatible host
    // reporting nonzero reasoning_tokens), not hardcoded to one provider, since the wire shape is
    // shared. Deliberately NOT a REASONING_BUDGET_MULTIPLE-style retry like anthropic.ts/
    // google.ts: also confirmed live, a tight max_tokens (10) truncated the visible completion
    // (finish_reason "length") while reasoning still ran to 681 tokens uncounted against that
    // cap — reasoning and the visible completion are billed on separate budgets here, so a
    // reasoning model has no less completion room than a non-reasoning one at the same
    // max_tokens; retrying with an enlarged budget would only inflate cost with no actual
    // truncation risk to fix.
    if (reasoningTokens > 0) {
      deviations.push(
        `mandatory reasoning (thinking cannot be disabled) — ${reasoningTokens} reasoning ` +
          `tokens used, billed separately from and not counted against max_tokens`,
      );
    }

    const adapterResult: AdapterResult = {
      text: response.choices[0]?.message.content ?? "",
      usage: {
        input: response.usage.prompt_tokens,
        output: response.usage.completion_tokens,
        cached_input: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
        reasoning: reasoningTokens,
      },
      latency_ms: latencyMs,
      raw: response,
      deviations,
    };
    return adapterResult;
  };
}

export const OPENAI_COMPATIBLE_HOSTS = {
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  together: "https://api.together.xyz/v1/chat/completions",
  fireworks: "https://api.fireworks.ai/inference/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  // Legacy Chat Completions endpoint (confirmed live against docs.x.ai — xAI's newer Responses
  // API exists but the OpenAI-compatible Chat Completions surface this adapter already speaks
  // is still fully supported). No provider-spread multi-host concern here the way OpenRouter's
  // entries have — this is the one direct xAI endpoint, not routed through anything else.
  xai: "https://api.x.ai/v1/chat/completions",
} as const;
