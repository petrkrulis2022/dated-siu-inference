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

  it("flags a quote a thousand times off its own tasks' cheapest prices, not against tasks it does not include", () => {
    // prices scaled ×1,000 from the original fixture so the cheapest reference (358,610 mSIU) is itself well above the smallest quote a whole-mSIU price can state (1
    // mSIU): the quote's price is parsed as a whole mSIU count (parse.ts, 2026-11-07), so a sub-mSIU "slip" amount can no longer be expressed to test against here.
    const board = {
      agu: 0n,
      askUsdcPerAgu: 13_296n,
      issuerPrices: [
        { issuer: "ISSUER-C1", task: "CR-PL", priceMicroSiu: 300_848_000n, skipped: false },
        { issuer: "ISSUER-C1", task: "CR-UO", priceMicroSiu: 57_762_000n, skipped: false },
        { issuer: "ISSUER-F", task: "CR-VS", priceMicroSiu: 19_076_246_000n, skipped: false },
      ],
    } as never;
    const quote = (msiu: string) =>
      parseReply(
        `{"reasoning": "r", "action": {"tool": "post_quote", "args": {"need": "n", "tasks": ["CR-PL", "CR-UO"], "price_msiu": "${msiu}"}}}`,
        "research",
        board,
      );
    const ordinary = quote("5000");
    expect(ordinary.ok && ordinary.flags).toEqual([]); // 5,000 mSIU against 358,610 mSIU: underpriced, not a scale slip
    const slip = quote("1");
    expect(slip.ok && slip.flags.length).toBe(1); // 1 mSIU against 358,610 mSIU: over a thousandfold below
  });

  it("refuses a decimal or zero price for a quote: it must be a whole, positive number of mSIU", () => {
    const quote = (msiu: string) =>
      parseReply(
        `{"reasoning": "r", "action": {"tool": "post_quote", "args": {"need": "n", "tasks": ["CR-PL", "CR-UO"], "price_msiu": "${msiu}"}}}`,
        "research",
      );
    expect(quote("0.25").ok).toBe(false);
    expect(quote("0").ok).toBe(false);
    expect(quote("250").ok && (quote("250") as { action: { priceMicroSiu: bigint } }).action.priceMicroSiu).toBe(
      250_000n,
    );
  });
});
