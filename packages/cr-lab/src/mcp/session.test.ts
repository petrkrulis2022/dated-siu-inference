import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixtureBackend } from "../data-desk/fixtures/backend.js";
import { Secret } from "../keys.js";
import { MemoryRecordStore } from "../runner/records.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { SpendPolicy } from "../spend/types.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import { anthropicMessagesApi, approxTokens } from "./anthropic-loop.js";
import { FakeMcp } from "./fake-mcp.js";
import { runMcpAnswer, runMcpDay } from "./session.js";
import { standInMessagesApi } from "./stand-in-agent.js";
import type { McpBackend } from "./types.js";

const NOW = new Date("2026-10-18T12:00:00Z");
const POLICY: SpendPolicy = {
  dailyCapUsd: "9",
  providers: { anthropic: { budgetUsd: "100", since: "2026-10-01T00:00:00Z" } },
};
const PRICE = { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" };

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
  tmp = mkdtempSync(join(tmpdir(), "cr-mcp-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const seat = () =>
  standInSeat("solver", { id: "claude-haiku-4-5", price: PRICE, provider: "anthropic" });
const ledgerWith = (policy = POLICY) =>
  new SpendLedger({ store: new MemoryLedgerStore(), policy, now: () => NOW });
const mcp = () => new FakeMcp({ backend: f.backend, today: f.day.window });
const answer = (
  kind: Parameters<typeof standInMessagesApi>[0],
  task: string,
  over: object = {},
) => {
  const instance = by[task] as Instance;
  const api = standInMessagesApi(kind, instance, f.day);
  const m = mcp();
  const ledger = ledgerWith();
  return {
    api,
    m,
    ledger,
    run: () =>
      runMcpAnswer({
        api,
        mcp: m,
        ledger,
        seat: seat(),
        instance,
        window: f.day.window,
        daySha256: "d".repeat(64),
        sessionsDir: tmp,
        now: () => NOW,
        ...over,
      }),
  };
};

describe("an MCP-mode session", () => {
  it("a careful agent reads the data, answers from what it was shown, and passes, with the whole session recorded", async () => {
    const a = answer("researcher", "CR-VS");
    const { record } = await a.run();
    expect(record).toMatchObject({ part: "mcp", task: "CR-VS", passed: true, failure_classes: [] });
    expect(record.mcp?.snapshot_check).toBe("same");
    expect(record.mcp?.tool_calls.length).toBeGreaterThanOrEqual(3);
    expect(record.mcp?.tool_calls.every((c) => !c.is_error && c.result_bytes > 0)).toBe(true);
    expect(record.mcp?.tools_offered.sort()).toEqual([
      "tabular_catalog",
      "tabular_data",
      "timeseries_catalog",
      "timeseries_data",
    ]);
    expect(record.mcp?.tools_withheld).toEqual(["search_documents"]);
    expect(a.ledger.report().spentToday).toBe(new D(record.usd).toFixed(6));
    expect(new D(record.usd).gt(0)).toBe(true);
    const saved = JSON.parse(
      readFileSync(join(tmp, `${record.instance}__${record.model}.json`), "utf-8"),
    );
    expect(saved.relayed).toHaveLength(record.mcp?.tool_calls.length ?? -1);
  });

  it("every task type is answered through the tools by the careful agent", async () => {
    for (const task of ["CR-PL", "CR-SM"]) {
      const { record } = await answer("researcher", task).run();
      expect(record.passed, task).toBe(true);
    }
  });

  it("an agent that reads too little gives an answer right for what it read and still fails, as wrong-dataset", async () => {
    const { record } = await answer("partial", "CR-VS").run();
    expect(record.passed).toBe(false);
    expect(record.mcp?.snapshot_check).toBe("differs");
    expect(record.primary_failure).toBe("wrong-dataset");
  });

  it("an agent that reads nothing and answers anyway cannot pass", async () => {
    const { record } = await answer("lazy", "CR-PL").run();
    expect(record.passed).toBe(false);
    expect(record.mcp?.tool_calls).toHaveLength(0);
    expect(record.primary_failure).toBe("wrong-dataset");
  });

  it("stops an agent that never stops: at the tool-call limit and at the turn limit, as session-limit", async () => {
    const calls = await answer("looper", "CR-VS", { limits: { maxToolCalls: 4 } }).run();
    expect(calls.record.mcp?.limit).toBe("max-tool-calls");
    expect(calls.record.mcp?.tool_calls).toHaveLength(4);
    expect(calls.record.primary_failure).toBe("session-limit");
    const turns = await answer("looper", "CR-VS", { limits: { maxTurns: 3 } }).run();
    expect(turns.record.mcp?.limit).toBe("max-turns");
    expect(turns.record.mcp?.turns).toHaveLength(3);
  });

  it("ends a session on its own spend cap before a call that could pass it, and on the conversation size", async () => {
    const cap = await answer("chatty", "CR-VS", { limits: { maxSessionUsd: "0.40" } }).run();
    expect(cap.record.mcp?.limit).toBe("session-cap");
    expect(new D(cap.record.usd).lte("0.40")).toBe(true);
    expect(cap.record.mcp?.turns.length ?? 0).toBeGreaterThan(0);
    const none = await answer("chatty", "CR-VS", { limits: { maxSessionUsd: "0.0001" } }).run();
    expect(none.record.mcp?.limit).toBe("session-cap");
    expect(none.record.mcp?.turns).toHaveLength(0);
    expect(none.record.usd).toBe("0");
    const ctx = await answer("looper", "CR-VS", { limits: { maxInputTokens: 50 } }).run();
    expect(ctx.record.mcp?.limit).toBe("context-limit");
  });

  it("keeps the assistant's turns exactly as returned, thinking blocks included, when it sends the next request", async () => {
    const a = answer("researcher", "CR-PL");
    await a.run();
    const second = a.api.requests[1] as {
      messages: { role: string; content: { type: string }[] }[];
    };
    const assistant = second.messages.find((m) => m.role === "assistant");
    expect(assistant?.content.map((b) => b.type)).toEqual(["thinking", "tool_use"]);
    expect(assistant?.content[0]).toEqual({
      type: "thinking",
      thinking: "plan the reads",
      signature: "sig-1",
    });
  });

  it("books the spend per turn through the guard, and a refusal ends the session, is recorded as far as it got, and is passed up", async () => {
    const a = answer("researcher", "CR-VS");
    const tiny = ledgerWith({ ...POLICY, dailyCapUsd: "0.05" });
    const { record, stopped } = await runMcpAnswer({
      api: a.api,
      mcp: a.m,
      ledger: tiny,
      seat: seat(),
      instance: by["CR-VS"] as Instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
      now: () => NOW,
    });
    expect(stopped?.code).toBe("daily-cap");
    expect(record.mcp?.limit).toBe("spend-guard");
    expect(record.passed).toBe(false);
    expect(a.api.requests).toHaveLength(0); // refused before the first model call
    expect(tiny.report().spentToday).toBe("0.000000");
  });

  it("never offers or forwards a withheld tool, even if the server lists it", async () => {
    const real = mcp();
    const withExtra: McpBackend = {
      name: "fake",
      tools: async () => [
        ...(await real.tools()),
        { name: "search_documents", description: "articles", inputSchema: { type: "object" } },
      ],
      call: (n, a) => real.call(n, a),
    };
    const instance = by["CR-PL"] as Instance;
    const api = standInMessagesApi("researcher", instance, f.day);
    const { record } = await runMcpAnswer({
      api,
      mcp: withExtra,
      ledger: ledgerWith(),
      seat: seat(),
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
    });
    expect(record.mcp?.tools_offered).not.toContain("search_documents");
    const sent = (api.requests[0] as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(sent).not.toContain("search_documents");
  });

  it("prices each turn on output alone, as Anthropic reports it, and records what it spent", async () => {
    const a = answer("researcher", "CR-PL");
    const { record } = await a.run();
    const sum = (record.mcp?.turns ?? []).reduce(
      (acc, t) =>
        acc
          .plus(new D(t.input_tokens).div(1e6).times(2))
          .plus(new D(t.output_tokens).div(1e6).times(10)),
      new D(0),
    );
    expect(new D(record.usd).minus(sum).abs().lte("0.000001")).toBe(true);
  });
});

describe("the Messages API client", () => {
  const KEY = new Secret("CR_ANTHROPIC_API_KEY", "test-key-value-123");
  const reply = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status });

  it("sends the key only as a header, retries a 429 and a server error, and reports how many tries", async () => {
    const seen: { headers: Record<string, string>; body: string }[] = [];
    const statuses = [429, 529, 200];
    const f2 = (async (_u: string, init: RequestInit) => {
      seen.push({ headers: init.headers as Record<string, string>, body: String(init.body) });
      const s = statuses.shift() as number;
      return reply(
        s,
        s === 200
          ? { content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
          : { error: { type: "overloaded" } },
      );
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const api = anthropicMessagesApi(KEY, {
      fetchImpl: f2,
      sleep: async (ms) => void slept.push(ms),
      delaysMs: [10, 20],
    });
    const r = await api.send({ model: "m", max_tokens: 5, messages: [] });
    expect(r).toMatchObject({ status: 200, attempts: 3 });
    expect(slept).toEqual([10, 20]);
    expect(seen[0]?.headers["x-api-key"]).toBe("test-key-value-123");
    expect(seen.every((s) => !s.body.includes("test-key-value-123"))).toBe(true);
  });

  it("gives up after the retries and does not retry a client error", async () => {
    let n = 0;
    const always = (async () => (n++, reply(529, {}))) as unknown as typeof fetch;
    const api = anthropicMessagesApi(KEY, {
      fetchImpl: always,
      sleep: async () => undefined,
      delaysMs: [1, 1],
    });
    expect((await api.send({})).attempts).toBe(3);
    let m = 0;
    const bad = (async () => (m++, reply(400, { error: {} }))) as unknown as typeof fetch;
    expect(
      (await anthropicMessagesApi(KEY, { fetchImpl: bad, sleep: async () => undefined }).send({}))
        .attempts,
    ).toBe(1);
    expect(n).toBe(3);
    expect(m).toBe(1);
  });

  it("a failed model call is recorded as call-failed with only the status, and costs nothing", async () => {
    const failing = {
      send: async () => ({
        status: 400,
        json: { error: { message: "secret detail" } },
        attempts: 1,
      }),
    };
    const instance = by["CR-PL"] as Instance;
    const { record } = await runMcpAnswer({
      api: failing,
      mcp: mcp(),
      ledger: ledgerWith(),
      seat: seat(),
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: tmp,
    });
    expect(record.error).toBe("HTTP 400");
    expect(record.primary_failure).toBe("call-failed");
    expect(record.usd).toBe("0");
    expect(JSON.stringify(record)).not.toContain("secret detail");
  });

  it("estimates the conversation's size for the cost projection", () => {
    expect(approxTokens([{ role: "user", content: "x".repeat(300) }], [])).toBeGreaterThanOrEqual(
      100,
    );
  });
});

describe("a day of MCP mode", () => {
  const world = () => ({
    ledger: ledgerWith(),
    seeds: new SeedBook({
      publicDir: join(tmp, "pub"),
      privateDir: join(tmp, "priv"),
      now: () => NOW,
      newSeed: () => "7".repeat(64),
    }),
    records: new MemoryRecordStore(),
  });
  const apiFor = (s: { modelId: string }) => {
    void s;
    // one scripted agent per instance: the day runner asks per seat, so route by the instance in the prompt
    return {
      send: async (body: Record<string, unknown>) => {
        const first = (body.messages as { content: string }[])[0]?.content ?? "";
        const task = first.includes("perpetual-futures")
          ? "CR-VS"
          : first.includes("lending protocol")
            ? "CR-PL"
            : "CR-SM";
        const inst = by[task] as Instance;
        return standInMessagesApi("researcher", inst, f.day).send(body);
      },
    };
  };

  it("runs one session per task per model, for the tasks MCP mode supports, and a second call asks nothing again", async () => {
    const w = world();
    const seats = [seat(), { ...seat(), modelId: "claude-sonnet-5" }];
    const input = {
      window: f.day.window,
      day: f.day,
      daySha256: "d".repeat(64),
      seats,
      ...w,
      mcp: mcp(),
      apiFor,
      sessionsDir: tmp,
      now: () => NOW,
    };
    const s = await runMcpDay(input);
    expect(s.planned).toBe(6); // CR-VS, CR-PL and CR-SM, two models
    expect(s).toMatchObject({ attempted: 6, complete: true });
    expect(s.passed).toBe(6);
    expect(w.records.forWindow(f.day.window).every((r) => r.part === "mcp")).toBe(true);
    const again = await runMcpDay(input);
    expect(again).toMatchObject({ attempted: 0, alreadyRecorded: 6, complete: true });
  });

  it("stops the day when the spend guard refuses, and says why", async () => {
    const w = { ...world(), ledger: ledgerWith({ ...POLICY, dailyCapUsd: "0.02" }) };
    const s = await runMcpDay({
      window: f.day.window,
      day: f.day,
      daySha256: "d".repeat(64),
      seats: [seat()],
      ...w,
      mcp: mcp(),
      apiFor,
      sessionsDir: tmp,
      now: () => NOW,
    });
    expect(s.stopped?.code).toBe("daily-cap");
    expect(s.complete).toBe(false);
    expect(s.attempted).toBe(1);
  });
});
