import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import type { ChatTurn, ToolChat } from "../mcp/tool-loop.js";
import { SpendLedger, SpendStopped } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { Board } from "./board.js";
import { instructionsFor, ModelAgent } from "./model-agent.js";
import { parseToolCall, toolDefsForRole } from "./parse.js";

const PRICE = { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" };
const board = { window: 1, round: 0 } as Board;

function fakeChat(
  turn: ChatTurn,
): ToolChat & { sent: { messages: unknown; tools: unknown; maxTokens: unknown; opts: unknown }[] } {
  const sent: { messages: unknown; tools: unknown; maxTokens: unknown; opts: unknown }[] = [];
  return {
    sent,
    provider: "anthropic",
    init: (prompt) => [{ role: "user", content: prompt }],
    toolSpecs: (tools) => tools,
    send: (messages, tools, maxTokens, opts) => {
      sent.push({ messages, tools, maxTokens, opts });
      return Promise.resolve(turn);
    },
    appendAssistant: () => undefined,
    appendToolResults: () => undefined,
  } as ToolChat & { sent: typeof sent };
}

const ledger = (dailyCapUsd = "9") =>
  new SpendLedger({
    store: new MemoryLedgerStore(),
    policy: { dailyCapUsd, providers: { anthropic: { budgetUsd: "50" } } } as never,
  });

describe("a model agent", () => {
  it("is given its role's tools, forces a tool call, returns it as toolCall, and bills exactly what the usage says", async () => {
    const chat = fakeChat({
      status: 200,
      attempts: 1,
      reply: {
        text: "",
        toolUses: [{ id: "t1", name: "pass", args: { reasoning: "nothing to do" } }],
        wantsTools: true,
        usage: { input: 1_000, output: 200, cachedInput: 0 },
        assistant: {},
      },
    });
    const l = ledger();
    const a = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-haiku-4-5",
      chat,
      PRICE,
      l,
      "CR_ANTHROPIC_API_KEY",
    );
    const r = await a.reply(board, "the board");
    expect(r.toolCall).toEqual({ tool: "pass", args: { reasoning: "nothing to do" } });
    // 1,000 in at $1/M + 200 out at $5/M = 0.001 + 0.001
    expect(r.costUsd.toFixed(6)).toBe("0.002000");
    const sent = chat.sent[0] as { tools: { name: string }[]; opts: { forceTool?: boolean } };
    expect(sent.tools.map((t) => t.name)).toEqual(toolDefsForRole("demand").map((d) => d.name));
    expect(sent.opts?.forceTool).toBe(true);
    expect(parseToolCall(r.toolCall, "demand").ok).toBe(true);
  });

  it("passes through the provider's own reasoning/thinking summary when it returns one, and omits the field when it doesn't", async () => {
    const toolUses = [{ id: "t1", name: "pass", args: { reasoning: "nothing to do" } }];
    const withSummary = fakeChat({
      status: 200,
      attempts: 1,
      reply: {
        text: "",
        toolUses,
        wantsTools: true,
        usage: { input: 1_000, output: 200, cachedInput: 0 },
        assistant: {},
        reasoning: {
          text: "thinking: the data agent needs USDC, paying that way",
          redactedBlocks: 0,
          emptyBlocks: 0,
        },
      },
    });
    const a = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-sonnet-5",
      withSummary,
      PRICE,
      ledger(),
      "CR_ANTHROPIC_API_KEY",
    );
    const r = await a.reply(board, "the board");
    expect(r.reasoningSummary).toBe("thinking: the data agent needs USDC, paying that way");

    const withoutSummary = fakeChat({
      status: 200,
      attempts: 1,
      reply: {
        text: "",
        toolUses,
        wantsTools: true,
        usage: { input: 1_000, output: 200, cachedInput: 0 },
        assistant: {},
      },
    });
    const b = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-haiku-4-5",
      withoutSummary,
      PRICE,
      ledger(),
      "CR_ANTHROPIC_API_KEY",
    );
    const rb = await b.reply(board, "the board");
    expect(rb.reasoningSummary).toBeUndefined();
  });

  it("a turn with no tool call at all leaves toolCall absent (left for parseToolCall to report as a failed turn)", async () => {
    const chat = fakeChat({
      status: 200,
      attempts: 1,
      reply: {
        text: "",
        toolUses: [],
        wantsTools: false,
        usage: { input: 1_000, output: 200, cachedInput: 0 },
        assistant: {},
      },
    });
    const a = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-haiku-4-5",
      chat,
      PRICE,
      ledger(),
      "CR_ANTHROPIC_API_KEY",
    );
    const r = await a.reply(board, "the board");
    expect(r.toolCall).toBeUndefined();
    expect(parseToolCall(r.toolCall, "demand").ok).toBe(false);
  });

  it("turns a provider failure into a service failure, billed at zero, not a parse failure", async () => {
    const chat = fakeChat({ status: 529, attempts: 3 });
    const a = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-haiku-4-5",
      chat,
      PRICE,
      ledger(),
      "CR_ANTHROPIC_API_KEY",
    );
    const r = await a.reply(board, "the board");
    expect(r.serviceFailure).toMatch(/529/);
    expect(r.costUsd.eq(new D(0))).toBe(true);
  });

  it("is refused by the spend guard before calling when the projected cost would cross the cap", async () => {
    const chat = fakeChat({ status: 200, attempts: 1 });
    const a = new ModelAgent(
      "DEMAND-1",
      "demand",
      "claude-haiku-4-5",
      chat,
      PRICE,
      ledger("0.000001"),
      "CR_ANTHROPIC_API_KEY",
    );
    await expect(a.reply(board, "the board")).rejects.toBeInstanceOf(SpendStopped);
    expect(chat.sent).toHaveLength(0);
  });
});

describe("the instructions", () => {
  it("say to call exactly one tool, reasoning first, and never tell an agent which way to pay -- the tools themselves are given natively, not restated here", () => {
    for (const role of ["demand", "research", "hedger"] as const) {
      const text = instructionsFor(role);
      expect(text).toMatch(/reasoning first/);
      expect(text).not.toMatch(/\b(should|must|prefer|better|best)\b.*\b(AGU-lab|USDC)\b/i);
    }
  });

  it("D137: each role is given exactly its own tools, natively, reasoning required and first in every schema", () => {
    expect(toolDefsForRole("demand").map((d) => d.name)).toContain("accept_quote");
    expect(toolDefsForRole("demand").map((d) => d.name)).not.toContain("commission_task");
    for (const role of ["demand", "research", "hedger"] as const)
      for (const d of toolDefsForRole(role)) {
        const schema = d.inputSchema as { properties: Record<string, unknown>; required: string[] };
        expect(Object.keys(schema.properties)[0]).toBe("reasoning");
        expect(schema.required[0]).toBe("reasoning");
      }
  });

  it("v2 item 11: names both currencies in the same sentence, and swaps which one comes first with the board's own display order", () => {
    const first = instructionsFor("research", true).match(/settle in SIU terms through AGU-lab|settle directly in USDC/);
    const flipped = instructionsFor("research", false).match(/settle in SIU terms through AGU-lab|settle directly in USDC/);
    expect(first?.[0]).toBe("settle in SIU terms through AGU-lab");
    expect(flipped?.[0]).toBe("settle directly in USDC");
  });

  it("v2 item 5: the hedger's role text names no currency at all (D131/D133: it used to name USDC alone, the one role the firing messages traced to)", () => {
    const text = instructionsFor("hedger");
    const roleLine = text.split("\n").find((l) => l.startsWith("You are the HEDGER"));
    expect(roleLine).not.toMatch(/AGU-lab|USDC/);
  });
});
