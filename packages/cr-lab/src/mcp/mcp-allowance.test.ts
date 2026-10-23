import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  MCP_ALLOWANCES_PATH,
  deriveAllowances,
  loadAllowances,
  mcpObservationsOf,
} from "../runner/allowance.js";
import type { AnswerRecord } from "../runner/records.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { SpendLedger } from "../spend/ledger.js";
import { MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay, type FixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, type Instance } from "../tasks/instances.js";
import { FakeMcp, LIVE_LAG } from "./fake-mcp.js";
import { runMcpAnswer } from "./session.js";
import { standInMessagesApi } from "./stand-in-agent.js";
import { toMcpInstance } from "./variants.js";

const rec = (task: AnswerRecord["task"], turns: { out: number; stop?: string }[]): AnswerRecord =>
  ({
    part: "mcp",
    task,
    mcp: {
      turns: turns.map((t, i) => ({
        turn: i + 1,
        input_tokens: 1000,
        output_tokens: t.out,
        usd: "0.01",
        latency_ms: 1,
        retries: 0,
        ...(t.stop !== undefined ? { stop_reason: t.stop } : {}),
      })),
    },
  }) as unknown as AnswerRecord;

describe("MCP mode's allowance: the same rule as snapshot mode, from MCP-mode turns (D120)", () => {
  it("takes one observation per model call, and a call cut off at the cap is only a lower bound", () => {
    const obs = mcpObservationsOf(
      rec("CR-VS", [
        { out: 150, stop: "tool_use" },
        { out: 32000, stop: "max_tokens" },
      ]),
    );
    expect(obs).toEqual([
      { task: "CR-VS", need: 150, censored: false },
      { task: "CR-VS", need: 32000, censored: true },
    ]);
    // a snapshot-mode answer is not an MCP session
    expect(mcpObservationsOf({ part: "snapshot", task: "CR-VS" } as AnswerRecord)).toEqual([]);
  });

  it("gives 6/5 of the largest turn, rounded up to 2,000, never below the print's own allowance", () => {
    const obs = [
      ...mcpObservationsOf(rec("CR-VS", [{ out: 32000, stop: "max_tokens" }])),
      ...mcpObservationsOf(rec("CR-PL", [{ out: 12194 }, { out: 900 }])),
      ...mcpObservationsOf(rec("CR-SM", [{ out: 3928 }])),
    ];
    expect(deriveAllowances(obs)).toEqual({
      "CR-VS": 40000, // 32,000 x 6/5 = 38,400, up to 40,000
      "CR-PL": 16000, // 12,194 x 6/5 = 14,632.8, up to 16,000
      "CR-UO": 4000, // no observation: the print's
      "CR-SM": 6000, // 3,928 x 6/5 = 4,713.6, up to 6,000, above the print's 4,000
    });
  });

  it("is frozen in a committed file whose every value is a multiple of 2,000 not below the print's", () => {
    const a = loadAllowances(MCP_ALLOWANCES_PATH);
    expect(a["CR-VS"]).toBeGreaterThan(32000); // the three cut-off turns of 20 to 22 October
    for (const v of Object.values(a)) expect(v % 2000).toBe(0);
  });
});

describe("a session's turns are held to its task's allowance, and the record says which", () => {
  let f: FixtureDay;
  let tmp: string;
  beforeAll(async () => {
    f = await fixtureDay(undefined, {}, LIVE_LAG);
  });
  afterAll(() => f.cleanup());
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cr-mcp-allow-"));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const seat = standInSeat("solver", { id: "stand-in-researcher", provider: "anthropic" });
  const play = async (task: Instance["task"], limits?: { maxTokensPerTurn: number }) => {
    const instance = drawInstances(f.day, "4".repeat(64), 1)
      .map((i) => toMcpInstance(i, f.day)?.instance)
      .find((i): i is Instance => i?.task === task) as Instance;
    const api = standInMessagesApi("researcher", instance, f.day);
    const out = await runMcpAnswer({
      api,
      mcp: new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG }),
      ledger: new SpendLedger({
        store: new MemoryLedgerStore(),
        policy: {
          dailyCapUsd: "9",
          providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
        },
      }),
      seat,
      instance,
      window: f.day.window,
      daySha256: "d".repeat(64),
      sessionsDir: join(tmp, "sessions"),
      ...(limits !== undefined ? { limits } : {}),
    });
    return { record: out.record, sent: api.requests.map((r) => r.max_tokens) };
  };

  it("sends each task's own per-turn allowance and records it", async () => {
    const allowance = loadAllowances(MCP_ALLOWANCES_PATH);
    for (const task of ["CR-VS", "CR-PL", "CR-SM"] as const) {
      const { record, sent } = await play(task);
      expect(new Set(sent), task).toEqual(new Set([allowance[task]]));
      expect(record.allowance_tokens, task).toBe(allowance[task]);
    }
  });

  it("an explicit limit overrides the frozen allowance, for a test or a hand run", async () => {
    const { record, sent } = await play("CR-PL", { maxTokensPerTurn: 5000 });
    expect(new Set(sent)).toEqual(new Set([5000]));
    expect(record.allowance_tokens).toBe(5000);
  });
});
