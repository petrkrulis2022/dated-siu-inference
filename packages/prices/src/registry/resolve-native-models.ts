/**
 * Resolves the current flagship/mid-tier model string for each native provider by calling
 * their own models-listing endpoint — never hardcoded, since dated model strings go stale.
 *
 * These three functions are exercised against real API responses only when the matching
 * API key is present; the selection heuristics below (regex on model id + "most recent"
 * sort) are reasonable and defensive but have only been verified against Anthropic's
 * documented /v1/models shape, not OpenAI's or Google's, since no key was available to
 * call those live while writing this. If a provider changes its naming convention, this
 * throws a clear "no match" error rather than silently picking the wrong model.
 */

export interface ResolvedTierPair {
  frontier: string;
  mid: string;
}

function pickLatest<T extends { id: string }>(
  candidates: T[],
  pattern: RegExp,
  sortKey: (item: T) => number,
): T {
  const matches = candidates.filter((m) => pattern.test(m.id));
  if (matches.length === 0) {
    throw new Error(
      `No model id matched ${pattern} among: ${candidates.map((m) => m.id).join(", ")}`,
    );
  }
  return matches.sort((a, b) => sortKey(b) - sortKey(a))[0];
}

interface AnthropicModel {
  id: string;
  created_at: string;
}

export async function resolveAnthropicModels(apiKey: string): Promise<ResolvedTierPair> {
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1000", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) {
    throw new Error(`Anthropic /v1/models failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: AnthropicModel[] };
  const byCreatedAt = (m: AnthropicModel) => new Date(m.created_at).getTime();
  return {
    frontier: pickLatest(body.data, /opus/i, byCreatedAt).id,
    mid: pickLatest(body.data, /haiku/i, byCreatedAt).id,
  };
}

interface OpenAiModel {
  id: string;
  created: number;
}

export async function resolveOpenAiModels(apiKey: string): Promise<ResolvedTierPair> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenAI /v1/models failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { data: OpenAiModel[] };
  const chatModels = body.data.filter(
    (m) =>
      /^gpt-/i.test(m.id) && !/audio|realtime|search|transcribe|instruct|embedding/i.test(m.id),
  );
  const byCreated = (m: OpenAiModel) => m.created;
  return {
    frontier: pickLatest(
      chatModels.filter((m) => !/mini|nano/i.test(m.id)),
      /^gpt-/i,
      byCreated,
    ).id,
    mid: pickLatest(chatModels, /mini/i, byCreated).id,
  };
}

interface GoogleModel {
  name: string;
}

export async function resolveGoogleModels(apiKey: string): Promise<ResolvedTierPair> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
  if (!res.ok) {
    throw new Error(`Google models list failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { models: GoogleModel[] };
  const stripped = body.models.map((m) => ({ id: m.name.replace(/^models\//, "") }));
  // Google doesn't expose a creation timestamp; fall back to lexicographic id ordering
  // as a "most recent version" proxy.
  const sortByIdDesc = (a: { id: string }, b: { id: string }) => (a.id < b.id ? 1 : -1);
  const proFamily = stripped.filter((m) => /gemini-.*-pro$/i.test(m.id)).sort(sortByIdDesc);
  const flashFamily = stripped.filter((m) => /gemini-.*-flash$/i.test(m.id)).sort(sortByIdDesc);
  if (proFamily.length === 0) {
    throw new Error(
      `No Gemini pro-tier model found among: ${stripped.map((m) => m.id).join(", ")}`,
    );
  }
  if (flashFamily.length === 0) {
    throw new Error(
      `No Gemini flash-tier model found among: ${stripped.map((m) => m.id).join(", ")}`,
    );
  }
  return { frontier: proFamily[0].id, mid: flashFamily[0].id };
}
