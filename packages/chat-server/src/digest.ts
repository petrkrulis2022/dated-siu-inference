import { callClaude, extractText, type AnthropicMessage } from "./anthropic-client.js";

/**
 * A short, fixed list of things Touchstone Assay has explicitly decided against (build sequence
 * boundaries in the repo's own CLAUDE.md — provider credits and reference-rate licensing are
 * Build 3, a token is explicitly never Build 1). Matching against this list is a deterministic
 * keyword check, not the model's free-form judgment about what counts as "unmet" — the brief's
 * own instruction: "flag anything matching a short fixed decided-against list... not free-form
 * judgment on what counts."
 */
const DECIDED_AGAINST: { label: string; pattern: RegExp }[] = [
  { label: "provider credits / prepaid compute", pattern: /\b(provider credits?|prepaid credits?|compute credits?)\b/i },
  { label: "a compute marketplace / brokering compute", pattern: /\b(compute market(place)?s?|buy compute|sell compute|gpu markets?)\b/i },
  { label: "a token, coin, or SIU-denominated instrument", pattern: /\b(tokens?|airdrops?|coins?|wsiu|siusd)\b/i },
];

export function findUnmetAsks(messages: string[]): string[] {
  const hits = new Set<string>();
  for (const message of messages) {
    for (const { label, pattern } of DECIDED_AGAINST) {
      if (pattern.test(message)) hits.add(label);
    }
  }
  return [...hits];
}

const CLUSTER_MAX_MESSAGES = 300;
const CLUSTER_MAX_CHARS_PER_MESSAGE = 300;
const CLUSTER_SYSTEM_PROMPT =
  "You summarise recurring visitor questions for an internal weekly report. Reply with only a JSON array of short strings (question themes, not quotes) and nothing else.";

/** One cheap Haiku call over a week's worth of (already PII-stripped) visitor messages, asked to
 * cluster them into common themes — free-form, unlike findUnmetAsks, because "what are people
 * generally asking about" genuinely benefits from the model's judgment; only the
 * decided-against flagging is pinned to a fixed list. Returns [] rather than throwing on any
 * failure — a digest with a missing theme list is far better than one that fails to generate at
 * all over a clustering-step hiccup. */
export async function clusterCommonQuestions(apiKey: string, model: string, messages: string[]): Promise<string[]> {
  if (messages.length === 0) return [];
  const sample = messages.slice(0, CLUSTER_MAX_MESSAGES).map((m) => m.slice(0, CLUSTER_MAX_CHARS_PER_MESSAGE));
  const prompt: AnthropicMessage[] = [
    {
      role: "user",
      content: `Visitor messages from this week's chat widget, one per line:\n\n${sample.join("\n")}\n\nGroup these into the most common question THEMES (not individual quotes). Reply with a JSON array of short strings only, at most 10 items.`,
    },
  ];
  try {
    const response = await callClaude(apiKey, model, CLUSTER_SYSTEM_PROMPT, prompt, [], 512);
    const parsed: unknown = JSON.parse(extractText(response).trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string").slice(0, 10);
  } catch {
    return [];
  }
}
