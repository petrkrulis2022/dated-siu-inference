/**
 * The reasoning a provider hands back with a reply, when it hands any back (the lab's policy since D52, kept here): read from the provider's own response, never coaxed out of the model. No
 * model setting is changed to get it (no extended thinking is switched on, no reasoning effort is set); the one request that touches the thinking setting is Claude Sonnet's `display:
 * "summarized"`, which asks for a summary of thinking that is already happening and, per D59, is meant not to change what the model does or what it costs. The owner decided (D107) that it is
 * requested in EVERY Sonnet session, MCP mode and snapshot mode alike, so every comparison in the trial runs under the same setting, and every record says what was requested. The check made
 * first was inconclusive: in the probe battery's stage 1, Sonnet's arm C (summary) differed from arm A in one cell (P0) by 57 points, Fisher p = 0.012, and about 4% of runs would show a gap
 * that large somewhere in 13 cells by chance, so noise is not ruled out and neither is an effect. A model that thinks privately and returns nothing (a summary withheld, or none offered at the
 * settings in use) simply has none here, and every report says so per model, so a gap is never mistaken for silence.
 * What is read, by response shape (mirroring the lab's extractor in the currency lab's package, which this package does not depend on):
 *   - an Anthropic message: content blocks of type `thinking` (their `thinking` text), a count of `thinking` blocks that came back with no text (the model thought and the text was not offered:
 *     claude-sonnet-5's default, `display: "omitted"`), and a count of `redacted_thinking` blocks;
 *   - an OpenAI-compatible chat completion (xAI, DeepSeek, Qwen on OpenRouter): `choices[0].message.reasoning_content` or `reasoning`;
 *   - an OpenAI Responses object: `output` items of type `reasoning`, their `summary` texts;
 *   - a Gemini response: parts marked `thought`.
 * OpenAI's own Chat Completions returns no reasoning text at all. The text is kept in full (it is private); a report cuts it for reading and says it cut.
 */
export interface ExtractedReasoning {
  /** the reasoning text as returned, joined; "" if none was returned */
  text: string;
  /** `redacted_thinking` blocks: returned by the provider, not readable */
  redactedBlocks: number;
  /** `thinking` blocks returned with no text: thinking happened and its text was not offered, which is different from a model that did not think */
  emptyBlocks: number;
}

const NONE: ExtractedReasoning = { text: "", redactedBlocks: 0, emptyBlocks: 0 };

const rec = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

export function extractReasoning(raw: unknown): ExtractedReasoning {
  const root = rec(raw);
  if (root === undefined) return NONE;
  // the Anthropic adapter keeps both calls when it retried a reply cut off by its reasoning budget: read the final one
  const body = rec(root.final) ?? root;
  const parts: string[] = [];
  let redacted = 0;
  let empty = 0;

  const message = rec(rec(arr(body.choices)[0])?.message);
  const compat = str(message?.reasoning_content) ?? str(message?.reasoning);
  if (compat !== undefined) parts.push(compat);

  for (const block of arr(body.content)) {
    const b = rec(block);
    if (b?.type === "thinking") {
      const t = str(b.thinking);
      if (t !== undefined) parts.push(t);
      else empty += 1;
    } else if (b?.type === "redacted_thinking") redacted += 1;
  }

  for (const item of arr(body.output)) {
    const o = rec(item);
    if (o?.type !== "reasoning") continue;
    for (const s of arr(o.summary)) {
      const t = str(rec(s)?.text);
      if (t !== undefined) parts.push(t);
    }
  }

  const content = rec(rec(arr(body.candidates)[0])?.content);
  for (const part of arr(content?.parts)) {
    const p = rec(part);
    if (p?.thought === true) {
      const t = str(p.text);
      if (t !== undefined) parts.push(t);
    }
  }
  return { text: parts.join("\n\n"), redactedBlocks: redacted, emptyBlocks: empty };
}

/** The same reading for a list of Anthropic content blocks (an assistant turn of the tool loop). */
export function reasoningOfBlocks(blocks: unknown[]): ExtractedReasoning {
  return extractReasoning({ content: blocks });
}

/** What was asked of the provider about reasoning: its summary, or nothing (the provider's defaults). Recorded with every answer. */
export type ReasoningRequest = "summary" | "default";

/**
 * The Claude models whose thinking text is hidden unless a summary is asked for; for these, and only these, the tool loop and the snapshot runner send `display: "summarized"` (D107).
 * Haiku's only thinking is manual, off by default, and changes its behaviour, so it is left at its defaults.
 */
const SUMMARY_REQUESTED_FOR: ReadonlySet<string> = new Set(["claude-sonnet-5"]);

export const requestsThinkingSummary = (modelString: string): boolean =>
  SUMMARY_REQUESTED_FOR.has(modelString);

/** Cuts a text for reading, saying so in the text itself: a cut is never read as the whole. */
export function cutForReading(text: string, cap: number): string {
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n[… cut at ${cap} of ${text.length} characters; the full text is in the private record]`;
}
