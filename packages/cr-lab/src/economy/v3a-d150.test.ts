/**
 * D150 (owner, 2026-11-19), the fixes before the freeze:
 *  1. a validation retry: a v3a tool call that fails the schema gets the parser's error back and one corrected call within the same turn; every retry is logged (agent,
 *     round, error, outcome) and a turn is lost only if the retry fails too -- the 1% lost-turn gate itself is unchanged;
 *  3. a run that stops partway still reports what actually ran (its cost and its turns), instead of $0.0000 and "0 of 0";
 *  4. spend is capped per run, not per UTC day; a counted run's cap is the parameters file's ($12).
 * (Item 2, the passive benchmark's sweep, is tested in v3a-passive.test.ts.)
 */
import { join } from "node:path";
import { D } from "@touchstone/sdk";
import { describe, expect, it } from "vitest";
import type { ChatTurn, ToolChat } from "../mcp/tool-loop.js";
import { CR_PUBLIC_DIR } from "../paths.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import type { Agent, AgentReply } from "./agents.js";
import { ScriptedV3aAgent } from "./agents-v3a.js";
import type { Board } from "./board.js";
import { EconomyLog } from "./log.js";
import { instructionsForV3a, ModelAgent } from "./model-agent.js";
import { loadParams, type EconomyParams } from "./params.js";
import { loadCrPrint, runWindows, type WindowStats } from "./runner.js";
import { checkGates } from "./v3a-gates.js";
import { buildV3aWorld, v3aAgentIds, v3aRunCapUsd } from "./v3a-run.js";
import type { Role } from "./world.js";

const V3A = join(CR_PUBLIC_DIR, "economy-params.v3a.json");
const T0 = Math.floor(Date.UTC(2026, 10, 16) / 1000);

function v3a(seed: string, patch?: (p: EconomyParams) => void) {
  const params = { ...loadParams(V3A), seed };
  patch?.(params);
  const { world, needsFor } = buildV3aWorld({ params, wp0: loadCrPrint(), log: new EconomyLog("stand-in"), t0: T0, arm: "A", volatility: "low", priceSeed: `price:${seed}` });
  return { world, needsFor, params };
}

/** a model seat whose first call each turn omits its reasoning (a schema failure), and whose retry answers `retry` */
function flaky(id: string, role: Role, retry: "fixed" | "broken" | "service" | undefined, errors: string[]): Agent {
  return {
    id,
    role,
    seat: "test-model",
    reply: () => Promise.resolve({ toolCall: { tool: "pass", args: {} }, costUsd: new D("0.01") }),
    ...(retry === undefined
      ? {}
      : {
          retry: (error: string): Promise<AgentReply> => {
            errors.push(error);
            if (retry === "service") return Promise.resolve({ costUsd: new D(0), serviceFailure: "model call failed (status 529)" });
            return Promise.resolve({ toolCall: { tool: "pass", args: { reasoning: retry === "fixed" ? "corrected" : "" } }, costUsd: new D("0.02") });
          },
        }),
  };
}

const cast = (params: EconomyParams, swap: Record<string, (id: string, role: Role) => Agent>): Agent[] =>
  v3aAgentIds(params).map(([id, role]) => swap[id]?.(id, role) ?? new ScriptedV3aAgent(id, role));
const instructions = (role: string, siuFirst: boolean) => instructionsForV3a(role as Role, siuFirst);

describe("D150 item 1: the validation retry", () => {
  it("returns the parser's error to the agent and executes its corrected call in the same turn; a retry that fails again loses the turn; every retry is logged", async () => {
    const { world, needsFor, params } = v3a("d150-retry");
    const errors1: string[] = [];
    const errors2: string[] = [];
    const agents = cast(params, { "DEMAND-1": (id, r) => flaky(id, r, "fixed", errors1), "DEMAND-2": (id, r) => flaky(id, r, "broken", errors2) });
    const stats = await runWindows({ world, agents, windows: [1], needsFor, instructions });
    const L = world.log.entries;
    const rounds = params.roundsPerWindow;
    // the agent got the parser's own error, once per turn
    expect(errors1).toEqual(Array.from({ length: rounds }, () => "reasoning must be a non-empty string"));
    expect(errors2.length).toBe(rounds);
    // every retry is logged: agent, round, the error, the outcome
    const retries = L.filter((e) => e.kind === "retry");
    expect(retries.filter((e) => e.actor === "DEMAND-1").map((e) => [e.round, e.error, e.outcome])).toEqual(
      Array.from({ length: rounds }, (_, r) => [r, "reasoning must be a non-empty string", "corrected"]),
    );
    expect(retries.filter((e) => e.actor === "DEMAND-2").map((e) => [e.round, e.outcome, e.retryError])).toEqual(
      Array.from({ length: rounds }, (_, r) => [r, "failed again", "reasoning must be a non-empty string"]),
    );
    expect(retries.every((e) => e.seat === "test-model" && typeof e.raw === "string")).toBe(true);
    // a corrected turn is executed and counts as a turn used; its stated reasoning is the corrected call's
    const turns = (a: string) => L.filter((e) => e.kind === "turn" && e.actor === a && e.mirror !== true);
    expect(turns("DEMAND-1").map((e) => [e.parsed, e.tool, e.retry])).toEqual(Array.from({ length: rounds }, () => [true, "pass", "corrected"]));
    expect(L.filter((e) => e.kind === "reasoning" && e.actor === "DEMAND-1").map((e) => e.text)).toEqual(Array.from({ length: rounds }, () => "corrected"));
    // a turn whose retry fails too is lost, exactly as before
    expect(turns("DEMAND-2").map((e) => [e.parsed, e.retry])).toEqual(Array.from({ length: rounds }, () => [false, "failed again"]));
    // a scripted seat never needs one
    expect(retries.filter((e) => e.actor !== "DEMAND-1" && e.actor !== "DEMAND-2")).toEqual([]);
    // the window's stats count the lost turns, the retries and their cost
    const s = stats[0] as WindowStats;
    expect([s.parseFailures, s.serviceFailures, s.retries, s.retriesCorrected]).toEqual([rounds, 0, 2 * rounds, rounds]);
    const mirrors = L.filter((e) => e.kind === "turn" && e.mirror === true).length;
    expect(s.agentCostUsd.toFixed(2)).toBe(new D("0.03").times(2 * rounds).plus(new D("0.01").times(mirrors)).toFixed(2));
    // the gate itself is unchanged: lost turns are the turns that stayed lost; its detail now says how many were retried
    const gate = checkGates(L, params).find((g) => g.name.startsWith("lost turns")) as { ok: boolean; detail: string };
    expect(gate.detail).toBe(`${rounds} of ${9 * rounds} lost (${rounds} parse, 0 service); ${2 * rounds} retried, ${rounds} corrected`);
    expect(gate.ok).toBe(false);
  });

  it("a retry lost to a service failure loses the turn, and an agent with no retry loses it as before", async () => {
    const { world, needsFor, params } = v3a("d150-retry-2", (p) => {
      p.roundsPerWindow = 1;
    });
    const agents = cast(params, { "DEMAND-1": (id, r) => flaky(id, r, "service", []), "DEMAND-2": (id, r) => flaky(id, r, undefined, []) });
    const stats = await runWindows({ world, agents, windows: [1], needsFor, instructions });
    const L = world.log.entries;
    expect(L.filter((e) => e.kind === "retry").map((e) => [e.actor, e.outcome, e.serviceFailure])).toEqual([["DEMAND-1", "service failure", "model call failed (status 529)"]]);
    const turn = (a: string) => L.find((e) => e.kind === "turn" && e.actor === a && e.mirror !== true);
    expect(turn("DEMAND-1")).toMatchObject({ parsed: false, error: "reasoning must be a non-empty string", retry: "service failure" });
    expect(turn("DEMAND-2")).toMatchObject({ parsed: false, error: "reasoning must be a non-empty string" });
    expect(turn("DEMAND-2")?.retry).toBeUndefined();
    expect(stats[0]).toMatchObject({ parseFailures: 2, retries: 1, retriesCorrected: 0 });
  });

  it("is v3a's alone: a v2 world loses a failed turn without asking again", async () => {
    // the v2 engine is frozen (D138); its counted run is reported and must replay as it ran
    const { world } = v3a("d150-v2");
    expect(world.v3a).toBeDefined();
    const { buildWorld, needsSchedule, standInSha } = await import("./runner.js");
    const { StandInWorker } = await import("./agents.js");
    const v2 = { ...loadParams(join(CR_PUBLIC_DIR, "economy-params.v2.json")), seed: "d150-v2" };
    const w2 = buildWorld({ params: v2, wp0: loadCrPrint(), log: new EconomyLog("stand-in"), worker: new StandInWorker("d150-v2", {}, standInSha("d150-v2")), t0: T0, dataSha: standInSha("d150-v2") });
    w2.genesis();
    const errors: string[] = [];
    const ids: [string, Role][] = [...v2.agents.research.map((a): [string, Role] => [a, "research"]), ...v2.agents.demand.map((a): [string, Role] => [a, "demand"]), [v2.agents.hedger, "hedger"]];
    const { ScriptedAgent } = await import("./agents.js");
    const agents = ids.map(([id, role]) => (id === "DEMAND-1" ? flaky(id, role, "fixed", errors) : new ScriptedAgent(id, role)));
    await runWindows({ world: w2, agents, windows: [1], needsFor: needsSchedule("d150-v2", ["CR-PL", "CR-UO", "CR-SM"]) });
    expect(errors).toEqual([]);
    expect(w2.log.entries.filter((e) => e.kind === "retry")).toEqual([]);
  });
});

describe("D150 item 1: a model agent's retry continues its own conversation", () => {
  const PRICE = { priceInUsdPer1M: "1", priceOutUsdPer1M: "5" };
  const board = { window: 3, round: 2 } as Board;
  function chat(turns: ChatTurn[]): ToolChat & { sent: unknown[][] } {
    const sent: unknown[][] = [];
    return {
      sent,
      provider: "anthropic",
      init: (prompt: string) => [{ role: "user", content: prompt }],
      toolSpecs: (tools: unknown) => tools,
      send: (messages: unknown[]) => {
        sent.push(structuredClone(messages));
        return Promise.resolve(turns.shift() as ChatTurn);
      },
      appendAssistant: (messages: unknown[], assistant: unknown) => void messages.push(assistant),
      appendToolResults: (messages: unknown[], results: unknown[]) => void messages.push({ role: "user", results }),
    } as unknown as ToolChat & { sent: unknown[][] };
  }
  const turn = (toolUses: { id: string; name: string; args: Record<string, unknown> }[]): ChatTurn => ({
    status: 200,
    attempts: 1,
    reply: { text: "", toolUses, wantsTools: toolUses.length > 0, usage: { input: 1_000, output: 200, cachedInput: 0 }, assistant: { role: "assistant", n: toolUses.length } },
  });
  const ledger = () => new SpendLedger({ store: new MemoryLedgerStore(), policy: { dailyCapUsd: "9", providers: { anthropic: { budgetUsd: "50", since: "2026-01-01T00:00:00Z" } } } });

  it("sends the failed call back with the parser's error as its tool result, forced to call a tool again, billed through the ledger", async () => {
    const c = chat([turn([{ id: "tu-1", name: "pass", args: {} }]), turn([{ id: "tu-2", name: "pass", args: { reasoning: "fixed" } }])]);
    const l = ledger();
    const a = new ModelAgent("DEMAND-1", "demand", "claude-haiku-5-5", c, PRICE, l, "CR_ANTHROPIC_API_KEY");
    await a.reply(board, "the board");
    const r = await a.retry("reasoning must be a non-empty string");
    expect(r.toolCall).toEqual({ tool: "pass", args: { reasoning: "fixed" } });
    expect(r.costUsd.toFixed(6)).toBe("0.002000");
    expect(c.sent[1]).toEqual([
      { role: "user", content: "the board" },
      { role: "assistant", n: 1 },
      {
        role: "user",
        results: [
          {
            id: "tu-1",
            isError: true,
            text: "This call could not be used: reasoning must be a non-empty string. Nothing happened. Call one tool again with corrected arguments, reasoning first; if this call cannot be used either, your turn this round is lost.",
          },
        ],
      },
    ]);
    expect(l.report().todayByPart.economy).toBe("0.004000");
  });

  it("a reply that named no tool is asked again from the start, with the error after the board", async () => {
    const c = chat([turn([]), turn([{ id: "tu-2", name: "pass", args: { reasoning: "fixed" } }])]);
    const a = new ModelAgent("DEMAND-1", "demand", "claude-haiku-5-5", c, PRICE, ledger(), "CR_ANTHROPIC_API_KEY");
    await a.reply(board, "the board");
    const r = await a.retry("no tool call in the reply");
    expect(r.toolCall?.args).toEqual({ reasoning: "fixed" });
    expect(c.sent[1]).toEqual([
      {
        role: "user",
        content:
          "the board\n\nYour reply could not be used: no tool call in the reply. Nothing happened. Call one tool with corrected arguments, reasoning first; if this call cannot be used either, your turn this round is lost.",
      },
    ]);
  });

  it("refuses a retry with no turn to retry", async () => {
    const a = new ModelAgent("DEMAND-1", "demand", "claude-haiku-5-5", chat([]), PRICE, ledger(), "CR_ANTHROPIC_API_KEY");
    await expect(a.retry("x")).rejects.toThrow(/no turn to retry/);
  });
});

describe("D150 item 3: a run that stops partway reports what actually ran", () => {
  it("the stats of every window that ran, the stopped one included, reach the caller when the run stops", async () => {
    const { world, needsFor, params } = v3a("d150-stop");
    const paying = (id: string, role: Role): Agent => {
      const inner = new ScriptedV3aAgent(id, role);
      return {
        id,
        role,
        seat: "scripted",
        reply: async (b: Board) => {
          if (b.window === 2 && b.round === 3) throw new Error("SPEND GUARD (run-cap): stopped");
          return { ...(await inner.reply(b)), costUsd: new D("0.01") };
        },
      };
    };
    const stats: WindowStats[] = [];
    await expect(runWindows({ world, agents: cast(params, { "DEMAND-1": paying }), windows: [1, 2, 3], needsFor, instructions, stats })).rejects.toThrow(/run-cap/);
    expect(stats.map((s) => s.window)).toEqual([1, 2]);
    expect(stats[0]?.turns).toBe(9 * params.roundsPerWindow);
    // window 2 ran rounds 0-2 in full and round 3 up to the refused call, which never ran
    expect(stats[1]?.turns).toBeGreaterThanOrEqual(9 * 3);
    expect(stats[1]?.turns).toBeLessThan(9 * 4);
    expect(stats.map((s) => s.agentCostUsd.toFixed(2))).toEqual([new D("0.01").times(params.roundsPerWindow).toFixed(2), "0.03"]);
  });
});

describe("D150 item 4: a spend cap per run", () => {
  it("the counted run cap is the parameters file's $12; a run without a cell must name its own; a counted cell can never be capped above $12", () => {
    const params = loadParams(V3A);
    expect(params.v3a?.countedRunCapUsd.toFixed(2)).toBe("12.00");
    expect(v3aRunCapUsd(params, { cell: "A-low-1" }).toFixed(2)).toBe("12.00");
    expect(v3aRunCapUsd(params, { cell: "A-low-1", given: "10" }).toFixed(2)).toBe("10.00");
    expect(() => v3aRunCapUsd(params, { cell: "A-low-1", given: "12.01" })).toThrow(/above the counted run cap of \$12\.00/);
    expect(v3aRunCapUsd(params, { given: "1" }).toFixed(2)).toBe("1.00");
    expect(() => v3aRunCapUsd(params, {})).toThrow(/--run-cap-usd/);
    expect(() => v3aRunCapUsd(params, { given: "0" })).toThrow(/positive/);
  });
});
