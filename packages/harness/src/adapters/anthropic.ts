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
    // Reused for the reasoning-truncation retry below — found live, 2026-09-24: that retry
    // hardcoded `true`, so a model that had already been confirmed to reject `temperature` (the
    // catch branch right below) would resend it anyway and 400 again, uncaught, the moment its
    // completion was also long enough to trip the reasoning-budget retry. Both accommodations are
    // real and independent; the second must not re-litigate what the first already determined.
    let includeTemperature = true;
    try {
      result = await callAnthropic(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      includeTemperature = false;
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callAnthropic(apiKey, modelString, prompt, params, false, params.max_tokens);
    }

    // Same architectural rule as google.ts's createGoogleAdapter — see its doc comment. A no-op
    // today: standard (non-extended-thinking) calls report 0 thinking tokens, so this never
    // triggers unless extended thinking is explicitly enabled for a candidate later.
    const truncatedResult = result;
    const truncatedByReasoning =
      truncatedResult.response.stop_reason === "max_tokens" &&
      (truncatedResult.response.usage.output_tokens_details?.thinking_tokens ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (stop_reason max_tokens, ` +
          `${truncatedResult.response.usage.output_tokens_details?.thinking_tokens} reasoning tokens ` +
          `against a ${params.max_tokens}-token task budget) — retried with reasoning accommodated ` +
          `above the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callAnthropic(apiKey, modelString, prompt, params, includeTemperature, accommodatedBudget);
    }

    const { response, latencyMs } = result;
    const text = response.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text)
      .join("");

    // Same real-cost fix as google.ts: the truncated first call is a real, separately-billed
    // request whose own usage must be summed in, not discarded — see google.ts's comment for the
    // full reasoning. Currently a no-op in practice (see comment above), kept structurally
    // identical to google.ts/openai.ts so it's correct the moment extended thinking is enabled.
    const truncatedUsage = truncatedByReasoning ? truncatedResult.response.usage : undefined;

    const result_: AdapterResult = {
      text,
      usage: {
        input: response.usage.input_tokens + (truncatedUsage?.input_tokens ?? 0),
        output: response.usage.output_tokens + (truncatedUsage?.output_tokens ?? 0),
        cached_input:
          (response.usage.cache_read_input_tokens ?? 0) +
          (truncatedUsage?.cache_read_input_tokens ?? 0),
        reasoning:
          (response.usage.output_tokens_details?.thinking_tokens ?? 0) +
          (truncatedUsage?.output_tokens_details?.thinking_tokens ?? 0),
      },
      latency_ms: latencyMs,
      raw: truncatedByReasoning ? { truncated: truncatedResult.response, final: response } : response,
      deviations,
      stopReason: response.stop_reason,
      contentBlockTypes: response.content.map((block) => block.type),
    };
    return result_;
  };
}
