import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Secret } from "../keys.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { SpendPolicy } from "../spend/types.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { DEFAULT_LIMITS, anthropicChat } from "./anthropic-loop.js";
import { FakeMcp } from "./fake-mcp.js";
import { openAiChat, openAiChatApi, type ChatCompletionsApi } from "./openai-loop.js";
import { runMcpAnswer } from "./session.js";
import { standInChatCompletionsApi, standInMessagesApi } from "./stand-in-agent.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: {
    openai: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" },
    anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" },
  },
};
const PRICE = { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10", priceCachedInUsdPer1M: "0.125" };

let f: FixtureDay;
let by: Record<string, Instance>;
let tmp: string;
beforeAll(async () => {
  f = await fixtureDay();
  const all = drawInstances(f.day, "7".repeat(64));
  by = Object.fromEntries(
    ["CR-VS", "CR-PL", "CR-SM"].map((t) => [t, all.find((i) => i.task === t) as Instance]),
  );
});
afterAll(() => f.cleanup());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-oai-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const seat = () => standInSeat("solver", { id: "gpt-5.1", price: PRICE, provider: "openai" });
const ledger = () =>
  new SpendLedger({ store: new MemoryLedgerStore(), policy: POLICY, now: () => NOW });
const mcp = () => new FakeMcp({ backend: f.backend, today: f.day.window });
const answer = (api: ChatCompletionsApi, task: string, over: object = {}) =>
  runMcpAnswer({
    chat: openAiChat(api, "gpt-5.1"),
    mcp: mcp(),
    ledger: ledger(),
    seat: seat(),
    instance: by[task] as Instance,
    window: f.day.window,
    daySha256: "d".repeat(64),
    sessionsDir: tmp,
    now: () => NOW,
    ...over,
  });

describe("the GPT tool loop on the fake server", () => {
  it("a careful agent reads the data through function tools and passes, for every task MCP mode runs", async () => {
    for (const task of ["CR-VS", "CR-PL", "CR-SM"]) {
      const api = standInChatCompletionsApi("researcher", by[task] as Instance, f.day);
      const { record } = await answer(api, task);
      expect(record, task).toMatchObject({
        part: "mcp",
        provider: "openai",
        model: "gpt-5.1",
        passed: true,
      });
      expect(record.mcp?.snapshot_check).toBe("same");
      expect(record.mcp?.tool_calls.length ?? 0).toBeGreaterThanOrEqual(1);
    }
  });

  it("speaks OpenAI's shapes: function tools, max_completion_tokens, no temperature, and tool results as tool messages answering the call's id", async () => {
    const api = standInChatCompletionsApi("researcher", by["CR-PL"] as Instance, f.day);
    await answer(api, "CR-PL");
    const first = api.requests[0] as {
      model: string;
      max_completion_tokens: number;
      tools: { type: string; function: { name: string; parameters: unknown } }[];
      temperature?: unknown;
    };
    expect(first.model).toBe("gpt-5.1");
    expect(first.max_completion_tokens).toBe(DEFAULT_LIMITS.maxTokensPerTurn);
    expect(first.temperature).toBeUndefined();
    expect(
      first.tools.every((t) => t.type === "function" && typeof t.function.name === "string"),
    ).toBe(true);
    expect(first.tools.map((t) => t.function.name).sort()).toEqual([
      "tabular_catalog",
      "tabular_data",
      "timeseries_catalog",
      "timeseries_data",
    ]);
    const second = api.requests[1] as {
      messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    };
    const assistant = second.messages.find((m) => m.role === "assistant");
    const tool = second.messages.find((m) => m.role === "tool");
    expect(assistant?.tool_calls?.[0]?.id).toBe("call_0");
    expect(tool?.tool_call_id).toBe("call_0");
  });

  it("an agent that reads nothing, or too little, fails as wrong-dataset; one that never stops ends on a limit", async () => {
    const lazy = await answer(
      standInChatCompletionsApi("lazy", by["CR-PL"] as Instance, f.day),
      "CR-PL",
    );
    expect(lazy.record.passed).toBe(false);
    expect(lazy.record.primary_failure).toBe("wrong-dataset");
    const partial = await answer(
      standInChatCompletionsApi("partial", by["CR-VS"] as Instance, f.day),
      "CR-VS",
    );
    expect(partial.record.mcp?.snapshot_check).toBe("differs");
    const looper = await answer(
      standInChatCompletionsApi("looper", by["CR-VS"] as Instance, f.day),
      "CR-VS",
      { limits: { maxToolCalls: 3 } },
    );
    expect(looper.record.mcp?.limit).toBe("max-tool-calls");
    expect(looper.record.primary_failure).toBe("session-limit");
  });

  it("prices cached prompt tokens at the cached rate and not again as input, and output once", async () => {
    let turns = 0;
    const api: ChatCompletionsApi = {
      async send() {
        turns += 1;
        return {
          status: 200,
          attempts: 1,
          json: {
            choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 200,
              completion_tokens_details: { reasoning_tokens: 150 },
              prompt_tokens_details: { cached_tokens: 600 },
            },
          },
        };
      },
    };
    const { record } = await answer(api, "CR-PL");
    expect(turns).toBe(1);
    // 400 x $1.25/M + 600 x $0.125/M + 200 x $10/M  (the reasoning is inside the 200, not added)
    const want = new D(400)
      .div(1e6)
      .times("1.25")
      .plus(new D(600).div(1e6).times("0.125"))
      .plus(new D(200).div(1e6).times(10));
    expect(new D(record.usd).minus(want).abs().lte("0.000000001")).toBe(true);
  });

  it("runs several tool calls from one turn, in order, each answered by its own tool message; a call with unreadable arguments gets an error, and the loop goes on", async () => {
    const seen: { role: string; tool_call_id?: string; content?: string }[][] = [];
    const api: ChatCompletionsApi = {
      async send(body) {
        const messages = body.messages as {
          role: string;
          tool_call_id?: string;
          content?: string;
        }[];
        seen.push(structuredClone(messages));
        if (messages.filter((m) => m.role === "assistant").length === 0)
          return {
            status: 200,
            attempts: 1,
            json: {
              choices: [
                {
                  finish_reason: "tool_calls",
                  message: {
                    role: "assistant",
                    content: null,
                    tool_calls: [
                      {
                        id: "a",
                        type: "function",
                        function: { name: "tabular_catalog", arguments: "{}" },
                      },
                      {
                        id: "b",
                        type: "function",
                        function: { name: "timeseries_data", arguments: "{not json" },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 20 },
            },
          };
        return {
          status: 200,
          attempts: 1,
          json: {
            choices: [{ message: { role: "assistant", content: "{}" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 80, completion_tokens: 5 },
          },
        };
      },
    };
    const { record } = await answer(api, "CR-PL");
    const tools = seen[1]?.filter((m) => m.role === "tool") ?? [];
    expect(tools.map((t) => t.tool_call_id)).toEqual(["a", "b"]);
    expect(tools[1]?.content).toMatch(/^Error: /);
    expect(record.mcp?.tool_calls.map((c) => [c.tool, c.is_error])).toEqual([
      ["tabular_catalog", false],
      ["timeseries_data", true],
    ]);
  });

  it("refuses to pair a Claude chat with a GPT seat", async () => {
    await expect(
      runMcpAnswer({
        chat: anthropicChat(standInMessagesApi("lazy", by["CR-PL"] as Instance, f.day), "x"),
        mcp: mcp(),
        ledger: ledger(),
        seat: seat(),
        instance: by["CR-PL"] as Instance,
        window: f.day.window,
        daySha256: "d".repeat(64),
        sessionsDir: tmp,
      }),
    ).rejects.toThrow(/served by openai/);
  });
});

describe("the Chat Completions client", () => {
  const KEY = new Secret("CR_OPENAI_API_KEY", "oai-test-key-123");
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it("sends the key only as a bearer header, retries 429 and server errors, and not a client error", async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const statuses = [429, 503, 200];
    const f2 = (async (_u: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      const s = statuses.shift() as number;
      return reply(s, s === 200 ? { choices: [] } : { error: {} });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const api = openAiChatApi(KEY, {
      fetchImpl: f2,
      sleep: async (ms) => void slept.push(ms),
      delaysMs: [5, 9],
    });
    expect(await api.send({ model: "m" })).toMatchObject({ status: 200, attempts: 3 });
    expect(slept).toEqual([5, 9]);
    expect(seen[0]?.headers.authorization).toBe("Bearer oai-test-key-123");
    expect(seen.every((s) => !s.body.includes("oai-test-key-123"))).toBe(true);
    let n = 0;
    const bad = (async () => (n++, reply(400, { error: {} }))) as unknown as typeof fetch;
    expect(
      (await openAiChatApi(KEY, { fetchImpl: bad, sleep: async () => undefined }).send({}))
        .attempts,
    ).toBe(1);
    expect(n).toBe(1);
  });

  it("a failed call is recorded as call-failed with only the status, and costs nothing", async () => {
    const failing: ChatCompletionsApi = {
      send: async () => ({
        status: 401,
        json: { error: { message: "secret detail" } },
        attempts: 1,
      }),
    };
    const { record } = await answer(failing, "CR-PL");
    expect(record.error).toBe("HTTP 401");
    expect(record.primary_failure).toBe("call-failed");
    expect(record.usd).toBe("0");
    expect(JSON.stringify(record)).not.toContain("secret detail");
  });
});
