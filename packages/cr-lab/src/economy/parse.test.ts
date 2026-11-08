import { describe, expect, it } from "vitest";
import { parseToolCall, toolDefsForRole, type ToolCall } from "./parse.js";

const call = (tool: string, args: Record<string, unknown> = {}): ToolCall => ({
  tool,
  args: { reasoning: "r", ...args },
});

describe("the tool-call parser", () => {
  it("accepts a valid call, reasoning carried alongside the tool's own args", () => {
    const r = parseToolCall(call("pass"), "demand");
    expect(r.ok && r.action.tool).toBe("pass");
    expect(r.ok && r.reasoning).toBe("r");
  });

  it("fails a turn with no tool call at all (the provider returned none, forced tool choice notwithstanding)", () => {
    expect(parseToolCall(undefined, "demand").ok).toBe(false);
  });

  it("requires a non-empty reasoning string", () => {
    expect(parseToolCall({ tool: "pass", args: {} }, "demand").ok).toBe(false);
    expect(parseToolCall({ tool: "pass", args: { reasoning: "  " } }, "demand").ok).toBe(false);
    expect(parseToolCall({ tool: "pass", args: { reasoning: 5 } }, "demand").ok).toBe(false);
  });

  it("refuses a tool the role does not have, and an amount that is not a plain decimal", () => {
    expect(parseToolCall(call("post_quote"), "demand").ok).toBe(false);
    expect(parseToolCall(call("buy_agu", { usdc: "1e3" }), "demand").ok).toBe(false);
    expect(parseToolCall(call("buy_agu", { usdc: "0.1234567" }), "demand").ok).toBe(false);
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
      parseToolCall(
        call("post_quote", { need: "n", tasks: ["CR-PL", "CR-UO"], price_msiu: msiu }),
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
      parseToolCall(call("post_quote", { need: "n", tasks: ["CR-PL", "CR-UO"], price_msiu: msiu }), "research");
    expect(quote("0.25").ok).toBe(false);
    expect(quote("0").ok).toBe(false);
    expect(quote("250").ok && (quote("250") as { action: { priceMicroSiu: bigint } }).action.priceMicroSiu).toBe(
      250_000n,
    );
  });
});

const TOOLS: Record<"demand" | "research" | "hedger", string[]> = {
  demand: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "accept_quote",
  ],
  research: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "post_quote",
    "buy_data",
    "commission_task",
    "deliver_brief",
  ],
  hedger: [
    "pass",
    "message",
    "buy_agu",
    "sell_agu",
    "redeem_agu",
    "present_claim",
    "order_front_claim",
    "commission_task",
    "buy_claims",
    "deliver_forward",
  ],
};

describe("the native tool defs (D137)", () => {
  it("list exactly a role's tools, each with reasoning as its first, required schema property", () => {
    for (const role of ["demand", "research", "hedger"] as const) {
      const defs = toolDefsForRole(role);
      expect(defs.map((d) => d.name)).toEqual(TOOLS[role]);
      for (const d of defs) {
        const schema = d.inputSchema as { properties: Record<string, unknown>; required: string[] };
        expect(Object.keys(schema.properties)[0]).toBe("reasoning");
        expect(schema.required[0]).toBe("reasoning");
      }
    }
  });

  it("gives every tool a non-empty description, carried from the old free-text hint text", () => {
    for (const role of ["demand", "research", "hedger"] as const)
      for (const d of toolDefsForRole(role)) expect(d.description.length).toBeGreaterThan(0);
  });
});
