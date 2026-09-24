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
    // Reused for the reasoning-truncation retry below — see anthropic.ts's identical fix and its
    // doc comment for the real failure this closes: that retry must not resend `temperature` once
    // the first call has already established the model rejects it.
    let includeTemperature = true;
    try {
      result = await callGoogle(apiKey, modelString, prompt, params, true, params.max_tokens);
    } catch (err) {
      if (!mentionsTemperature(err)) {
        throw err;
      }
      includeTemperature = false;
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
    // model's real capability at the price it actually charges.
    // finishReason "MAX_TOKENS" + nonzero thoughtsTokenCount is the provider's own signal that
    // this happened, not an inference from output length. REASONING_BUDGET_MULTIPLE bounds the
    // accommodation so this can't become an unbounded allowance.
    const truncatedResult = result;
    const truncatedByReasoning =
      truncatedResult.response.candidates[0]?.finishReason === "MAX_TOKENS" &&
      (truncatedResult.response.usageMetadata.thoughtsTokenCount ?? 0) > 0;
    if (truncatedByReasoning) {
      const accommodatedBudget = params.max_tokens * (1 + REASONING_BUDGET_MULTIPLE);
      deviations.push(
        `completion truncated by mandatory reasoning (finishReason MAX_TOKENS, ` +
          `${truncatedResult.response.usageMetadata.thoughtsTokenCount} reasoning tokens against a ` +
          `${params.max_tokens}-token task budget) — retried with reasoning accommodated above ` +
          `the task budget, capped at ${REASONING_BUDGET_MULTIPLE}x (${accommodatedBudget} tokens total)`,
      );
      result = await callGoogle(apiKey, modelString, prompt, params, includeTemperature, accommodatedBudget);
    }

    const { response, latencyMs } = result;
    const text = (response.candidates[0]?.content.parts ?? [])
      .map((part) => part.text ?? "")
      .join("");

    // The truncated first call is a real, separately-billed generateContent request — found live,
    // 2026-09-13: this project's own cost never priced it because `result` was reassigned wholesale
    // above, discarding the first response's usageMetadata entirely rather than adding it in. Google
    // bills both calls; this project's own number must sum both too, or it understates real cost on
    // every instance this retry fires for (routine for gemini-3.1-pro-preview, since it can't turn
    // thinking off). The truncated call's own usageMetadata is the real, provider-reported count for
    // exactly what it consumed before hitting the budget — not an estimate.
    const truncatedUsage = truncatedByReasoning ? truncatedResult.response.usageMetadata : undefined;

    const adapterResult: AdapterResult = {
      text,
      usage: {
        input: response.usageMetadata.promptTokenCount + (truncatedUsage?.promptTokenCount ?? 0),
        output:
          response.usageMetadata.candidatesTokenCount + (truncatedUsage?.candidatesTokenCount ?? 0),
        cached_input:
          (response.usageMetadata.cachedContentTokenCount ?? 0) +
          (truncatedUsage?.cachedContentTokenCount ?? 0),
        reasoning:
          (response.usageMetadata.thoughtsTokenCount ?? 0) +
          (truncatedUsage?.thoughtsTokenCount ?? 0),
      },
      latency_ms: latencyMs,
      raw: truncatedByReasoning ? { truncated: truncatedResult.response, final: response } : response,
      deviations,
    };
    return adapterResult;
  };
}
