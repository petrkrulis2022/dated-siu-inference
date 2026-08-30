import {
  AdapterHttpError,
  REASONING_BUDGET_MULTIPLE,
  type Adapter,
  type AdapterParams,
  type AdapterResult,
} from "./types.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  stop_reason?: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    // Present (0 unless extended thinking is explicitly enabled) as of the current API — the
    // "always folded into output_tokens, never reported separately" this field used to be
    // documented as no longer holds; read it rather than hardcode 0, so this stays correct if
    // extended thinking is ever turned on for a candidate here.
    output_tokens_details?: { thinking_tokens?: number };
  };
}

async function callAnthropic(
  apiKey: string,
  modelString: string,
  prompt: string,
  params: AdapterParams,
  includeTemperature: boolean,
  maxTokens: number,
): Promise<{ response: AnthropicResponse; latencyMs: number }> {
  const body: Record<string, unknown> = {
    model: modelString,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (includeTemperature) {
    body.temperature = params.temperature;
  }

  const start = Date.now();
  const res = await fetch(ANTHROPIC_MESSAGES_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errorBody = await res.json().catch(() => undefined);
    throw new AdapterHttpError(`Anthropic request failed: ${res.status}`, res.status, errorBody);
  }

  return { response: (await res.json()) as AnthropicResponse, latencyMs };
}

function mentionsTemperature(err: unknown): boolean {
  return (
    err instanceof AdapterHttpError &&
    err.status === 400 &&
    /temperature/i.test(JSON.stringify(err.body))
  );
}

export function createAnthropicAdapter(apiKey: string): Adapter {
  return async (modelString, prompt, params) => {
    const deviations: string[] = [];
    let result: { response: AnthropicResponse; latencyMs: number };
    try {
      result = await callAnthropic(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callAnthropic(apiKey, modelString, prompt, params, false, params.max_tokens);
    }

    // Same architectural rule as google.ts's createGoogleAdapter — see its doc comment. A no-op
    // today: standard (non-extended-thinking) calls report 0 thinking tokens, so this never
    // triggers unless extended thinking is explicitly enabled for a candidate later.
    const truncatedByReasoning =
      result.response.stop_reason === "max_tokens" &&
      (result.response.usage.output_tokens_details?.thinking_tokens ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (stop_reason max_tokens, ` +
          `${result.response.usage.output_tokens_details?.thinking_tokens} reasoning tokens ` +
          `against a ${params.max_tokens}-token task budget) — retried with reasoning accommodated ` +
          `above the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callAnthropic(apiKey, modelString, prompt, params, true, accommodatedBudget);
    }

    const { response, latencyMs } = result;
    const text = response.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");

    const result_: AdapterResult = {
      text,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
        cached_input: response.usage.cache_read_input_tokens ?? 0,
        reasoning: response.usage.output_tokens_details?.thinking_tokens ?? 0,
      },
      latency_ms: latencyMs,
      raw: response,
      deviations,
    };
    return result_;
  };
}
