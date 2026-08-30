import {
  AdapterHttpError,
  REASONING_BUDGET_MULTIPLE,
  type Adapter,
  type AdapterParams,
  type AdapterResult,
} from "./types.js";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleResponse {
  candidates: { content: { parts: { text?: string }[] }; finishReason?: string }[];
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
  maxOutputTokens: number,
): Promise<{ response: GoogleResponse; latencyMs: number }> {
  const generationConfig: Record<string, unknown> = { maxOutputTokens };
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
      result = await callGoogle(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      deviations.push(
        "temperature forced to provider default (request without temperature=0 was rejected)",
      );
      result = await callGoogle(apiKey, modelString, prompt, params, false, params.max_tokens);
    }

    // docs/methodology.md's Quality gates section: a provider that reports reasoning tokens
    // separately and cannot disable thinking (Gemini 3.1 Pro: a real 400 confirms this — "This
    // model only works in thinking mode") must not have its mandatory reasoning compete with the
    // answer for the same task-defined budget. That's not a level playing field across
    // architectures, it's a tighter constraint for one of them — a benchmark artifact, not the
    // model's real capability at the price it actually charges (reasoning tokens are billed as
    // output either way, so the cost is captured correctly regardless of this retry).
    // finishReason "MAX_TOKENS" + nonzero thoughtsTokenCount is the provider's own signal that
    // this happened, not an inference from output length. REASONING_BUDGET_MULTIPLE bounds the
    // accommodation so this can't become an unbounded allowance.
    const truncatedByReasoning =
      result.response.candidates[0]?.finishReason === "MAX_TOKENS" &&
      (result.response.usageMetadata.thoughtsTokenCount ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (finishReason MAX_TOKENS, ` +
          `${result.response.usageMetadata.thoughtsTokenCount} reasoning tokens against a ` +
          `${params.max_tokens}-token task budget) — retried with reasoning accommodated above ` +
          `the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callGoogle(apiKey, modelString, prompt, params, true, accommodatedBudget);
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
