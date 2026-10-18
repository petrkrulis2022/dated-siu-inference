/**
 * MCP mode, one window (D101, §16.8): models research the answer through the Blockworks data tools, and are graded from the data they were shown.
 *
 *   pnpm --filter @touchstone/cr-lab run run-mcp-day
 *       FIXTURES, scripted stand-in agents on synthetic data: spends and calls nothing.
 *   pnpm --filter @touchstone/cr-lab run run-mcp-day -- --models claude-haiku-4-5,claude-sonnet-5 --yes-spend [--tasks CR-VS,CR-PL,CR-SM] [--max-sessions 6] [--session-usd 1.00]
 *       REAL MODELS (Anthropic, the trial key) against the FAKE MCP server over SYNTHETIC fixture data: this tests how real models use the tools. It spends money (the spend guard still stops it at the
 *       cap or at a budget, and each session has its own cap) but makes NO Blockworks request and uses no Blockworks data. Records stay in memory and are printed, never written as the trial's.
 *
 * The live Blockworks MCP is not connected yet: it signs in by OAuth in a browser, once, by the owner (D91), and its tool results must be checked against the assumed shape first.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trialKey } from "../keys.js";
import { MemoryRecordStore } from "../runner/records.js";
import { daySha256 } from "../runner/run-day.js";
import { buildSeats } from "../runner/seats.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { cumulativeTable, dailyTable, failureReport } from "../runner/tables.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore, MemoryLedgerStore } from "../spend/store.js";
import { fixtureDay } from "../tasks/fixture-day.js";
import { drawInstances, TASKS, type TaskId } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import { anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { FakeMcp } from "../mcp/fake-mcp.js";
import { buildMcpPrompt } from "../mcp/prompts.js";
import { MCP_TASKS, runMcpDay } from "../mcp/session.js";
import { routedStandInApi, type AgentKind } from "../mcp/stand-in-agent.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (l: string) => console.log(`${stamp()} ${l}`);

const tasks = (opt("tasks") ?? MCP_TASKS.join(",")).split(",").map((t) => {
  if (!(TASKS as readonly string[]).includes(t)) throw new Error(`unknown task ${t}`);
  return t as TaskId;
});
const maxSessions = opt("max-sessions") !== undefined ? Number(opt("max-sessions")) : undefined;
const sessionUsd = opt("session-usd");
const limits = sessionUsd !== undefined ? { maxSessionUsd: sessionUsd } : undefined;

const f = await fixtureDay();
const tmp = mkdtempSync(join(tmpdir(), "cr-mcp-day-"));
try {
  const mcp = new FakeMcp({ backend: f.backend, today: f.day.window });
  const instances = drawInstances(f.day, "5".repeat(64), 1).filter((i) => tasks.includes(i.task));
  const promptOf = (i: (typeof instances)[number]) => buildMcpPrompt(i, f.day.window).text;
  const records = new MemoryRecordStore();
  const seeds = new SeedBook({
    publicDir: join(tmp, "pub"),
    privateDir: join(tmp, "priv"),
    newSeed: () => "5".repeat(64),
  });
  const common = {
    window: f.day.window,
    day: f.day,
    daySha256: daySha256(f.store, f.day.window),
    seeds,
    records,
    mcp,
    tasks,
    sessionsDir: join(tmp, "sessions"),
    ...(maxSessions !== undefined ? { maxSessions } : {}),
    ...(limits !== undefined ? { limits } : {}),
    log,
  };

  if (opt("models") === undefined) {
    // ---- scripted stand-ins: nothing real is touched ----
    const kinds: AgentKind[] = ["researcher", "partial", "lazy", "looper"];
    const seats = kinds.map((k) =>
      standInSeat("solver", { id: `stand-in-${k}`, provider: "anthropic" }),
    );
    const apiBy = new Map(
      kinds.map((k) => [`stand-in-${k}`, routedStandInApi(k, instances, f.day, promptOf)]),
    );
    const ledger = new SpendLedger({
      store: new MemoryLedgerStore(),
      policy: {
        dailyCapUsd: "9",
        providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
      },
    });
    const summary = await runMcpDay({
      ...common,
      seats,
      ledger,
      apiFor: (s) => apiBy.get(s.modelId)!,
      limits: { maxToolCalls: 12, maxTurns: 10, ...(limits ?? {}) },
    });
    const all = records.forWindow(f.day.window);
    console.log(
      `\nFIXTURES (scripted stand-in agents, synthetic data; nothing spent, nothing called)`,
    );
    console.log(JSON.stringify(summary));
    console.log(
      `\n${dailyTable(all, f.day.window, "MCP mode")}\n${cumulativeTable(all, "MCP mode")}\n${failureReport(all, f.day.window)}`,
    );
  } else {
    // ---- real Anthropic models against the fake MCP on synthetic data ----
    if (!flag("yes-spend")) {
      console.error(
        `refusing: this spends real money on ${opt("models")} (about $1 to $3 for a full day of sessions on Sonnet and Haiku). Add --yes-spend to go ahead; the spend guard still stops it at the cap or at a budget, and every session has its own cap.`,
      );
      process.exit(2);
    }
    const modelIds = (opt("models") as string).split(",").filter((m) => m !== "");
    const seats = buildSeats(modelIds);
    const api = anthropicMessagesApi(trialKey("anthropic"));
    const ledger = new SpendLedger({
      store: new FileLedgerStore(),
      policy: policyFromBudgets(loadBudgets()),
    });
    log("REAL models, FAKE MCP on SYNTHETIC data: no Blockworks request, no Blockworks data");
    const summary = await runMcpDay({ ...common, seats, ledger, apiFor: () => api });
    const all = records.forWindow(f.day.window);
    console.log(`\n${JSON.stringify(summary)}`);
    console.log(
      `trial spend today: $${ledger.report().spentToday} of the $${ledger.report().dailyCapUsd} cap`,
    );
    console.log(
      `\n${dailyTable(all, f.day.window, "MCP mode")}\n${failureReport(all, f.day.window)}`,
    );
    for (const r of all)
      console.log(
        `${r.instance} ${r.model}: ${r.mcp?.tool_calls.length ?? 0} tool calls, ${r.mcp?.turns.length ?? 0} turns, snapshot check ${r.mcp?.snapshot_check}${r.mcp?.limit ? `, ended on ${r.mcp.limit}` : ""}, $${r.usd}`,
      );
    if (summary.stopped !== undefined) process.exit(3);
  }
} finally {
  f.cleanup();
  rmSync(tmp, { recursive: true, force: true });
}
