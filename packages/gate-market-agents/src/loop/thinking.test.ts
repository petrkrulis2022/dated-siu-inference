import { describe, expect, it } from "vitest";
import { extractThinking, THINKING_CAP_CHARS } from "./thinking.js";

describe("extractThinking — what a provider returned of its reasoning, and nothing it was not asked for", () => {
  it("reads an OpenAI-compatible chat completion's reasoning_content (xAI)", () => {
    const raw = { choices: [{ message: { content: '{"wait":true}', reasoning_content: "I hold both assets; the quote is 1.2 SIU." } }] };
    expect(extractThinking(raw)).toBe("I hold both assets; the quote is 1.2 SIU.");
  });

  it("reads Anthropic thinking blocks and counts redacted ones without reading them", () => {
    const raw = { content: [{ type: "thinking", thinking: "First, the price." }, { type: "redacted_thinking", data: "x" }, { type: "text", text: "{}" }] };
    expect(extractThinking(raw)).toBe("First, the price.\n\n[1 redacted thinking block(s): returned by the provider, not readable]");
  });

  it("reads an OpenAI Responses object's reasoning summaries", () => {
    const raw = { output: [{ type: "reasoning", summary: [{ type: "summary_text", text: "Weighing the two routes." }] }, { type: "message", content: [] }] };
    expect(extractThinking(raw)).toBe("Weighing the two routes.");
  });

  it("reads Gemini parts marked as thoughts and not the answer", () => {
    const raw = { candidates: [{ content: { parts: [{ text: "thinking aloud", thought: true }, { text: "the answer" }] } }] };
    expect(extractThinking(raw)).toBe("thinking aloud");
  });

  it("returns nothing when the provider returned no reasoning: a plain reply, an empty field, a response of another shape", () => {
    expect(extractThinking({ content: [{ type: "text", text: "{}" }] })).toBeUndefined();
    expect(extractThinking({ choices: [{ message: { content: "x", reasoning_content: "  " } }] })).toBeUndefined();
    expect(extractThinking({ output: [{ type: "reasoning", summary: [] }] })).toBeUndefined();
    expect(extractThinking(undefined)).toBeUndefined();
    expect(extractThinking("text")).toBeUndefined();
  });

  it("states a cut in the text, so a truncation is never read as the whole", () => {
    const long = "x".repeat(THINKING_CAP_CHARS + 500);
    const out = extractThinking({ choices: [{ message: { reasoning_content: long } }] })!;
    expect(out.length).toBeLessThan(long.length);
    expect(out).toContain(`[… cut at ${THINKING_CAP_CHARS} of ${THINKING_CAP_CHARS + 500} characters]`);
  });
});
