/**
 * The reasoning a provider hands back with a reply, when it hands any back — read from the provider's own response, never asked for.
 *
 * The lab changes no model setting to get this: no extended thinking is switched on and no reasoning effort is changed. A model that thinks
 * privately and returns nothing of it (a summary withheld, or none offered at the settings in use) simply has none here, and the run's
 * report says so per model rather than leaving a gap to be mistaken for silence. What is read, by response shape:
 *   - an `xAI` or other OpenAI-compatible chat completion: `choices[0].message.reasoning_content` (or `reasoning`);
 *   - an Anthropic message: content blocks of type `thinking` (their `thinking` text), and a count of `redacted_thinking` blocks;
 *   - an OpenAI Responses object: `output` items of type `reasoning`, their `summary` texts;
 *   - a Gemini response: parts marked `thought`.
 * The text is capped; a cap is stated in the text itself, so a truncation is never read as the whole.
 */
export const THINKING_CAP_CHARS = 12_000;

const asRecord = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v : undefined);

export function extractThinking(raw: unknown): string | undefined {
  const root = asRecord(raw);
  if (root === undefined) return undefined;
  const parts: string[] = [];

  const message = asRecord(asRecord(asArray(root.choices)[0])?.message);
  const compat = str(message?.reasoning_content) ?? str(message?.reasoning);
  if (compat !== undefined) parts.push(compat);

  let redacted = 0;
  for (const block of asArray(root.content)) {
    const b = asRecord(block);
    if (b?.type === "thinking") {
      const t = str(b.thinking);
      if (t !== undefined) parts.push(t);
    } else if (b?.type === "redacted_thinking") redacted += 1;
  }
  if (redacted > 0) parts.push(`[${redacted} redacted thinking block(s): returned by the provider, not readable]`);

  for (const item of asArray(root.output)) {
    const o = asRecord(item);
    if (o?.type !== "reasoning") continue;
    for (const s of asArray(o.summary)) {
      const t = str(asRecord(s)?.text);
      if (t !== undefined) parts.push(t);
    }
  }

  const content = asRecord(asRecord(asArray(root.candidates)[0])?.content);
  for (const part of asArray(content?.parts)) {
    const p = asRecord(part);
    if (p?.thought === true) {
      const t = str(p.text);
      if (t !== undefined) parts.push(t);
    }
  }

  if (parts.length === 0) return undefined;
  const text = parts.join("\n\n");
  return text.length <= THINKING_CAP_CHARS ? text : `${text.slice(0, THINKING_CAP_CHARS)}\n[… cut at ${THINKING_CAP_CHARS} of ${text.length} characters]`;
}
