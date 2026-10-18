import { describe, expect, it } from "vitest";
import { cutForReading, extractReasoning, reasoningOfBlocks } from "./reasoning.js";

describe("reading a provider's reasoning from its response", () => {
  it("reads Anthropic thinking blocks, and counts redacted ones without reading them", () => {
    const r = extractReasoning({
      content: [
        { type: "thinking", thinking: "First I need the catalog.", signature: "s" },
        { type: "redacted_thinking", data: "xxxx" },
        { type: "text", text: "Let me look." },
      ],
    });
    expect(r).toEqual({ text: "First I need the catalog.", redactedBlocks: 1, emptyBlocks: 0 });
  });

  it("reads an OpenAI-compatible reasoning_content or reasoning, a Responses summary, and Gemini thought parts", () => {
    expect(
      extractReasoning({ choices: [{ message: { content: "x", reasoning_content: "because" } }] })
        .text,
    ).toBe("because");
    expect(
      extractReasoning({ choices: [{ message: { content: "x", reasoning: "since" } }] }).text,
    ).toBe("since");
    expect(
      extractReasoning({
        output: [
          { type: "reasoning", summary: [{ text: "summary one" }, { text: "summary two" }] },
        ],
      }).text,
    ).toBe("summary one\n\nsummary two");
    expect(
      extractReasoning({
        candidates: [
          { content: { parts: [{ thought: true, text: "thinking" }, { text: "answer" }] } },
        ],
      }).text,
    ).toBe("thinking");
  });

  it("finds nothing where the provider returned nothing, and tells a thinking block with no text from no thinking at all", () => {
    const none = { text: "", redactedBlocks: 0, emptyBlocks: 0 };
    expect(
      extractReasoning({
        choices: [{ message: { content: "answer" } }],
        usage: { completion_tokens_details: { reasoning_tokens: 40 } },
      }),
    ).toEqual(none);
    expect(extractReasoning(null)).toEqual(none);
    expect(extractReasoning("text")).toEqual(none);
    // Sonnet's default: it thought, and the text was not offered
    expect(
      reasoningOfBlocks([
        { type: "thinking", thinking: "", signature: "s" },
        { type: "text", text: "x" },
      ]),
    ).toEqual({ text: "", redactedBlocks: 0, emptyBlocks: 1 });
  });

  it("reads the final response when the adapter kept a truncated first call beside it", () => {
    const r = extractReasoning({
      truncated: { content: [{ type: "thinking", thinking: "cut off" }] },
      final: { content: [{ type: "thinking", thinking: "the real one" }] },
    });
    expect(r.text).toBe("the real one");
  });

  it("cuts a text for reading and says so, and leaves a short one whole", () => {
    expect(cutForReading("short", 100)).toBe("short");
    const cut = cutForReading("x".repeat(500), 100);
    expect(cut.startsWith("x".repeat(100))).toBe(true);
    expect(cut).toMatch(/cut at 100 of 500 characters/);
  });
});
