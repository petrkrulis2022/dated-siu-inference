/**
 * Reasoning and communication capture (D107): what a session's transcript holds, what is asked of each provider about reasoning, and that snapshot mode captures only what the provider
 * returns. Everything here runs on stand-ins; nothing calls a provider.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildPrompt } from "../runner/prompts.js";
import { runAnswer } from "../runner/run-answer.js";
import { standInAdapter, standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { SpendPolicy } from "../spend/types.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { FakeMcp } from "./fake-mcp.js";
import { openAiChat } from "./openai-loop.js";
import { runMcpAnswer } from "./session.js";
import { standInChatCompletionsApi, standInMessagesApi } from "./stand-in-agent.js";
import { reasoningStats, type TranscriptEvent } from "./transcript.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: {
    anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" },
    openai: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" },
  },
};
const PRICE = { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" };

let f: FixtureDay;
let instance: Instance;
let tmp: string;
beforeAll(async () => {
  f = await fixtureDay();
  instance = drawInstances(f.day, "7".repeat(64)).find((i) => i.task === "CR-VS") as Instance;
});
afterAll(() => f.cleanup());
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cr-reason-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const ledger = () =>
  new SpendLedger({ store: new MemoryLedgerStore(), policy: POLICY, now: () => NOW });
const claudeSeat = (modelString: string) => ({
  ...standInSeat("solver", { id: modelString, price: PRICE, provider: "anthropic" }),
  modelString,
});

async function claudeSession(modelString: string) {
  const api = standInMessagesApi("researcher", instance, f.day);
  const out = await runMcpAnswer({
    api,
    mcp: new FakeMcp({ backend: f.backend, today: f.day.window }),
    ledger: ledger(),
    seat: claudeSeat(modelString),
    instance,
    window: f.day.window,
    daySha256: "d".repeat(64),
    sessionsDir: tmp,
    now: () => NOW,
  });
  const saved = JSON.parse(
    readFileSync(join(tmp, `${out.record.instance}__${out.record.model}.json`), "utf-8"),
  ) as { transcript: TranscriptEvent[]; reasoning_requested: string };
  return { ...out, api, saved };
}

describe("the session transcript", () => {
  it("is ordered: reasoning, narration, each call then its result, the final answer, then how it ended", async () => {
    const { record, saved } = await claudeSession("claude-sonnet-5");
    const kinds = saved.transcript.map((e) => e.kind);
    expect(kinds.slice(0, 4)).toEqual(["reasoning", "narration", "tool_call", "tool_result"]);
    expect(kinds.at(-2)).toBe("final");
    expect(kinds.at(-1)).toBe("end");
    // every call is followed by its own result, in the order made
    const calls = saved.transcript.filter((e) => e.kind === "tool_call");
    const results = saved.transcript.filter((e) => e.kind === "tool_result");
    expect(calls).toHaveLength(record.mcp?.tool_calls.length ?? -1);
    expect(results).toHaveLength(calls.length);
    expect(saved.transcript.at(-1)).toEqual({ turn: record.mcp?.turns.length, kind: "end" });
  });

  it("keeps result sizes, never the results, which the session file holds once, in `relayed`", async () => {
    const { saved } = await claudeSession("claude-sonnet-5");
    for (const e of saved.transcript.filter((x) => x.kind === "tool_result"))
      expect(Object.keys(e).sort()).toEqual(["is_error", "kind", "result_bytes", "tool", "turn"]);
  });

  it("says how a session that hit a limit ended", async () => {
    const api = standInMessagesApi("looper", instance, f.day);
    const out = await runMcpAnswer({
      api,
      mcp: new FakeMcp({ backend: f.backend, today: f.day.window }),
      ledger: ledger(),
      seat: claudeSeat("claude-haiku-4-5-20251001"),
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
      limits: { maxToolCalls: 3 },
      now: () => NOW,
    });
    const saved = JSON.parse(
      readFileSync(join(tmp, `${out.record.instance}__${out.record.model}.json`), "utf-8"),
    ) as { transcript: TranscriptEvent[] };
    expect(saved.transcript.at(-1)).toMatchObject({ kind: "end", limit: "max-tool-calls" });
  });
});

describe("what is asked of each provider about reasoning", () => {
  it("Sonnet is asked for its thinking summary on every request, and the record says so", async () => {
    const { record, api, saved } = await claudeSession("claude-sonnet-5");
    expect(api.requests.length).toBeGreaterThan(1);
    for (const body of api.requests)
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(record.reasoning).toMatchObject({
      requested: "summary",
      turns_with_reasoning: 1,
      empty_blocks: 0,
      narration_turns: 1,
    });
    expect(saved.reasoning_requested).toBe("summary");
    const reasoning = saved.transcript.find((e) => e.kind === "reasoning");
    expect(reasoning).toMatchObject({ text: "plan the reads" });
  });

  it("Haiku is asked for nothing: no thinking setting is sent", async () => {
    const { record, api } = await claudeSession("claude-haiku-4-5-20251001");
    for (const body of api.requests) expect("thinking" in body).toBe(false);
    expect(record.reasoning?.requested).toBe("default");
  });

  it("a model that thinks and is not asked for the text has an empty block counted, which is not the same as no thinking", async () => {
    // the stand-in returns a thinking block with no text when no summary is requested, as Sonnet does by default
    const api = standInMessagesApi("researcher", instance, f.day);
    const { anthropicChat } = await import("./anthropic-loop.js");
    const out = await runMcpAnswer({
      chat: anthropicChat(api, "claude-sonnet-5", { summary: false }),
      mcp: new FakeMcp({ backend: f.backend, today: f.day.window }),
      ledger: ledger(),
      seat: claudeSeat("claude-sonnet-5"),
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
      now: () => NOW,
    });
    expect(out.record.reasoning).toMatchObject({
      requested: "default",
      turns_with_reasoning: 0,
      reasoning_chars: 0,
      empty_blocks: 1,
    });
    for (const body of api.requests) expect("thinking" in body).toBe(false);
  });

  it("GPT's narration is captured, nothing is asked of it, and none of its reasoning comes back from Chat Completions", async () => {
    const api = standInChatCompletionsApi("researcher", instance, f.day);
    const out = await runMcpAnswer({
      chat: openAiChat(api, "gpt-5.1"),
      mcp: new FakeMcp({ backend: f.backend, today: f.day.window }),
      ledger: ledger(),
      seat: {
        ...standInSeat("solver", { id: "gpt-5.1", price: PRICE, provider: "openai" }),
        modelString: "gpt-5.1",
      },
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
      now: () => NOW,
    });
    expect(out.record.reasoning).toMatchObject({
      requested: "default",
      turns_with_reasoning: 0,
      empty_blocks: 0,
      narration_turns: 1,
    });
    for (const body of api.requests) expect("reasoning" in body || "thinking" in body).toBe(false);
  });
});

describe("snapshot mode captures only what the provider returns", () => {
  const bundle = () => buildPrompt(instance, f.day) as NonNullable<ReturnType<typeof buildPrompt>>;
  const adapterWith = (raw: unknown) => {
    const inner = standInAdapter("solver");
    return async (...args: Parameters<typeof inner>) => ({ ...(await inner(...args)), raw });
  };
  const run = (seat: ReturnType<typeof standInSeat>) =>
    runAnswer({
      ledger: ledger(),
      seat,
      instance,
      bundle: bundle(),
      window: f.day.window,
      daySha256: "d".repeat(64),
      now: () => NOW,
    });

  it("keeps the reasoning text the provider returned, and counts the blocks it did not offer", async () => {
    const seat = {
      ...standInSeat("solver", { price: PRICE }),
      params: { temperature: 0, max_tokens: 4000, thinking: { mode: "summarized" as const } },
      adapter: adapterWith({
        content: [
          { type: "thinking", thinking: "Rank the venues by total volume.", signature: "s" },
          { type: "redacted_thinking", data: "x" },
          { type: "text", text: "{}" },
        ],
      }),
    };
    const rec = await run(seat);
    expect(rec.reasoning).toMatchObject({
      requested: "summary",
      turns_with_reasoning: 1,
      redacted_blocks: 1,
      empty_blocks: 0,
    });
    expect(rec.reasoning_text).toBe("Rank the venues by total volume.");
  });

  it("records nothing of reasoning when the provider returned none, and says none was asked for", async () => {
    const rec = await run(standInSeat("solver", { price: PRICE }));
    expect(rec.reasoning).toMatchObject({ requested: "default", turns_with_reasoning: 0 });
    expect("reasoning_text" in rec).toBe(false);
  });

  it("asks for no extra output: the answer's tokens and cost are the same with or without the capture", async () => {
    const plain = await run(standInSeat("solver", { price: PRICE }));
    const withText = await run({
      ...standInSeat("solver", { price: PRICE }),
      adapter: adapterWith({ content: [{ type: "thinking", thinking: "x".repeat(2000) }] }),
    });
    expect(withText.tokens).toEqual(plain.tokens);
    expect(withText.usd).toBe(plain.usd);
    expect(withText.raw_output).toBe(plain.raw_output);
  });
});

describe("the counts", () => {
  it("are taken from the transcript, so they cannot disagree with it", () => {
    const t: TranscriptEvent[] = [
      { turn: 1, kind: "reasoning", text: "abc", redacted_blocks: 1, empty_blocks: 0 },
      { turn: 1, kind: "narration", text: "hello" },
      { turn: 2, kind: "reasoning", text: "", redacted_blocks: 0, empty_blocks: 2 },
      { turn: 3, kind: "final", text: "{}" },
    ];
    expect(reasoningStats(t, "summary")).toEqual({
      requested: "summary",
      turns_with_reasoning: 1,
      reasoning_chars: 3,
      redacted_blocks: 1,
      empty_blocks: 2,
      narration_turns: 1,
      narration_chars: 5,
    });
  });
});
