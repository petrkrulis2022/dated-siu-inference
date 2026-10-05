import { describe, expect, it } from "vitest";
import { TOOLS } from "../tools/index.js";
import { TOOL_DESCRIPTIONS, formatToolList } from "./tool-descriptions.js";
import { ASSET_PREFERENCE_BLOCKLIST } from "./validate.js";

describe("TOOL_DESCRIPTIONS", () => {
  it("has an entry for every tool actually in the real TOOLS registry — the drift guard", () => {
    for (const toolName of Object.keys(TOOLS)) {
      expect(TOOL_DESCRIPTIONS).toHaveProperty(toolName);
    }
  });

  it("has no stale entry for a tool that no longer exists", () => {
    for (const toolName of Object.keys(TOOL_DESCRIPTIONS)) {
      expect(TOOLS).toHaveProperty(toolName);
    }
  });

  it("formatToolList emits every description, newline-separated", () => {
    const list = formatToolList();
    // Asserted by content rather than by line count. A description may legitimately span several
    // lines: `submit_job`'s carries a worked example of the gate module it expects, added
    // 2026-09-29 after both issuers in P5 run 3 failed to produce one. Counting lines would have
    // forced that example onto a single unreadable line to satisfy the test, which is the test
    // dictating the prompt rather than checking it.
    for (const description of Object.values(TOOL_DESCRIPTIONS)) {
      expect(list).toContain(description);
    }
    expect(list.split("\n").length).toBeGreaterThanOrEqual(Object.keys(TOOL_DESCRIPTIONS).length);
  });

  it(
    "every description opens with its own tool name, so a multi-line entry is still " +
      "attributable to the tool it describes",
    () => {
      for (const [toolName, description] of Object.entries(TOOL_DESCRIPTIONS)) {
        expect(description.startsWith(`${toolName}(`)).toBe(true);
      }
    },
  );
});

describe("the payment tools are described neutrally and in parallel", () => {
  // Tool descriptions are shown to every agent every turn, and they sit OUTSIDE both checks the
  // skill pack gets: the byte-comparison of the canonical asset text and the pre-turn validator's
  // blocklist (which searches the pack and the tool-call history, not these). Price parity is
  // stated here, so this is where it has to be held to the same standard.
  it("no description, of any tool, contains a phrase the asset-preference blocklist names", () => {
    for (const [tool, description] of Object.entries(TOOL_DESCRIPTIONS)) {
      const lower = description.toLowerCase();
      for (const phrase of ASSET_PREFERENCE_BLOCKLIST) {
        expect(lower.includes(phrase), `${tool} contains "${phrase}"`).toBe(false);
      }
    }
  });

  it("no payment tool frames one asset as the alternative to the other, or as better, cheaper or free", () => {
    // Not blocklisted phrases, and each can lean an agent: "in fSIU instead of USDC" makes USDC the
    // default; "free transfer" sells one route on its cost. Describing what a tool DOES, in terms
    // that do not rank it, is the standard.
    const loaded = [/instead of/i, /\bcheap/i, /\bbetter\b/i, /\bbest\b/i, /\bfaster\b/i, /\bfree\b/i, /recommend/i, /\bshould\b/i, /prefer/i, /\bdefault\b/i];
    for (const tool of ["pay", "pay_with_claim", "settle_split", "transfer_claim"] as const) {
      for (const re of loaded) {
        expect(re.test(TOOL_DESCRIPTIONS[tool]), `${tool} matches ${re}`).toBe(false);
      }
    }
  });

  it("pay and pay_with_claim state the same things in the same order, about their own asset", () => {
    const pay = TOOL_DESCRIPTIONS.pay;
    const claim = TOOL_DESCRIPTIONS.pay_with_claim;
    // Same opening, differing only in the asset named.
    expect(pay).toMatch(/^pay\(requestId, settler\) -> settles a quote the seller issued, in USDC: /);
    expect(claim).toMatch(/^pay_with_claim\(requestId, forWindow\?\) -> settles a quote the seller issued, in fSIU: /);
    // Each says how the amount is set from the quote, and each says where the asset goes.
    for (const d of [pay, claim]) {
      expect(d, d).toMatch(/quote's (own )?(dollar )?price/);
      expect(d, d).toMatch(/seller/);
    }
    // And neither is padded: one description may not run to more than 1.6x the other.
    const [short, long] = [pay.length, claim.length].sort((a, b) => a - b);
    expect(long / short).toBeLessThan(1.6);
  });

  it("states price parity as a fact about fSIU's sizing, without ranking it against USDC", () => {
    expect(TOOL_DESCRIPTIONS.pay_with_claim).toContain("worth the quote's dollar price at the print in force");
    expect(TOOL_DESCRIPTIONS.transfer_claim).toContain("worth its dollar price at the print in force");
  });
});
