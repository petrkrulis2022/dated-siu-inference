import { describe, expect, it } from "vitest";
import { isEmptyAtTokenBudget } from "./empty-completion.js";

describe("isEmptyAtTokenBudget", () => {
  it.each([
    ["Anthropic", "max_tokens"],
    ["OpenAI-shaped", "length"],
    ["Google", "MAX_TOKENS"],
  ])("is true for %s's own spelling of 'ran out of tokens' with no text", (_provider, stop) => {
    expect(isEmptyAtTokenBudget({ text: "", stopReason: stop })).toBe(true);
    expect(isEmptyAtTokenBudget({ text: "  \n ", stopReason: stop })).toBe(true);
  });

  it("is false when the model got far enough to emit text — a truncated reply is the model's own", () => {
    expect(isEmptyAtTokenBudget({ text: '{"tool": "pay", "args": {', stopReason: "max_tokens" })).toBe(
      false,
    );
  });

  it("is false for an empty completion that ended for any other reason", () => {
    expect(isEmptyAtTokenBudget({ text: "", stopReason: "end_turn" })).toBe(false);
    expect(isEmptyAtTokenBudget({ text: "", stopReason: "stop" })).toBe(false);
    expect(isEmptyAtTokenBudget({ text: "", stopReason: undefined })).toBe(false);
  });
});
