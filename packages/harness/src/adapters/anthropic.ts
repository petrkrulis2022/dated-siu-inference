import { AdapterHttpError, type Adapter, type AdapterParams, type AdapterResult } from "./types.js";

const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicResponse {
  content: { type: string; text?: string }[];
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

async function callAnthropic(
  apiKey: string,
  modelString: string,
  prompt: string,
  params: AdapterParams,
  includeTemperature: boolean,
): Promise<{ response: AnthropicResponse; latencyMs: number }> {
  const body: Record<string, unknown> = {
    model: modelString,
    max_tokens: params.max_tokens,
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
      result = await callAnthropic(apiKey, modelString, prompt, params, true);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callAnthropic(apiKey, modelString, prompt, params, false);
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
        // Anthropic doesn't report extended-thinking tokens as a separate usage field —
        // they're already folded into output_tokens.
        reasoning: 0,
      },
      latency_ms: latencyMs,
      raw: response,
      deviations,
    };
    return result_;
  };
}
