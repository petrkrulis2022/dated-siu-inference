import { describe, expect, it } from "vitest";
import { parseReply } from "./parse.js";

const obj = '{"reasoning": "nothing to do", "action": {"tool": "pass", "args": {}}}';

describe("the reply parser", () => {
  it("reads exactly one JSON object, reasoning first", () => {
    const r = parseReply(obj, "demand");
    expect(r.ok && r.action.tool).toBe("pass");
    expect(r.ok && r.fenced).toBe(false);
  });

  it("reads a reply that is exactly one fenced block from inside the fence, and marks it fenced (the gate's rule)", () => {
    for (const text of [
      "```json\n" + obj + "\n```",
      "```\n" + obj + "\n```",
      "  ```json\n" + obj + "```  ",
    ]) {
      const r = parseReply(text, "demand");
      expect(r.ok, text).toBe(true);
      expect(r.ok && r.fenced).toBe(true);
    }
  });

  it("still fails anything else around the object: prose before or after, two blocks, or reasoning second", () => {
    for (const text of [
      "Here is my answer:\n```json\n" + obj + "\n```",
      "```json\n" + obj + "\n```\nI hope this helps.",
      "```json\n" + obj + "\n```\n```json\n" + obj + "\n```",
      '{"action": {"tool": "pass", "args": {}}, "reasoning": "second"}',
    ])
      expect(parseReply(text, "demand").ok, text).toBe(false);
  });

  it("refuses a tool the role does not have, and an amount that is not a plain decimal", () => {
    expect(
      parseReply('{"reasoning": "r", "action": {"tool": "post_quote", "args": {}}}', "demand").ok,
    ).toBe(false);
    expect(
      parseReply(
        '{"reasoning": "r", "action": {"tool": "buy_agu", "args": {"usdc": "1e3"}}}',
        "demand",
      ).ok,
    ).toBe(false);
    expect(
      parseReply(
        '{"reasoning": "r", "action": {"tool": "buy_agu", "args": {"usdc": "0.1234567"}}}',
        "demand",
      ).ok,
    ).toBe(false);
  });
});
