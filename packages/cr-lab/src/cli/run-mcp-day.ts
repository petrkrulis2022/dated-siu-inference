/**
 * MCP mode, one window (D101, §16.8): models research the answer through the Blockworks data tools, and are graded from the data they were shown.
 *
 *   pnpm --filter @touchstone/cr-lab run run-mcp-day
 *       FIXTURES, scripted stand-in agents on synthetic data: spends and calls nothing.
 *   pnpm --filter @touchstone/cr-lab run run-mcp-day -- --models claude-haiku-4-5,claude-sonnet-5 --yes-spend [--tasks CR-VS,CR-PL,CR-SM] [--max-sessions 6] [--session-usd 1.00] [--max-tokens 32000]
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
import { anthropicChat, anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { openAiChat, openAiChatApi } from "../mcp/openai-loop.js";
import { FakeMcp, LIVE_LAG } from "../mcp/fake-mcp.js";
import { buildMcpPrompt } from "../mcp/prompts.js";
import { MCP_TASKS, runMcpDay } from "../mcp/session.js";
import { toMcpInstance } from "../mcp/variants.js";
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
const maxTokens = opt("max-tokens") !== undefined ? Number(opt("max-tokens")) : undefined;
const limits =
  sessionUsd !== undefined || maxTokens !== undefined
    ? {
        ...(sessionUsd !== undefined ? { maxSessionUsd: sessionUsd } : {}),
        ...(maxTokens !== undefined ? { maxTokensPerTurn: maxTokens } : {}),
      }
    : undefined;

// fixtures that behave like the live data where it matters: the stablecoin series publish a day late
const f = await fixtureDay(undefined, {}, LIVE_LAG);
const tmp = mkdtempSync(join(tmpdir(), "cr-mcp-day-"));
try {
  const mcp = new FakeMcp({ backend: f.backend, today: f.day.window, lagByModel: LIVE_LAG });
  // MCP mode asks its own version of the volume question (three months)
  const instances = drawInstances(f.day, "5".repeat(64), 1)
    .filter((i) => tasks.includes(i.task))
    .map((i) => toMcpInstance(i, f.day)?.instance)
    .filter((i): i is NonNullable<typeof i> => i !== undefined);
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
    const kinds: AgentKind[] = ["researcher", "partial", "careless", "lazy", "looper"];
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
    // each seat talks to its own provider with its own trial key (Claude: the Messages API; GPT: Chat Completions)
    const claude = seats.some((x) => x.provider === "anthropic")
      ? anthropicMessagesApi(trialKey("anthropic"))
      : undefined;
    const gpt = seats.some((x) => x.provider === "openai")
      ? openAiChatApi(trialKey("openai"))
      : undefined;
    const chatFor = (seat: (typeof seats)[number]) => {
      if (seat.provider === "anthropic" && claude !== undefined)
        return anthropicChat(claude, seat.modelString);
      if (seat.provider === "openai" && gpt !== undefined) return openAiChat(gpt, seat.modelString);
      throw new Error(`MCP mode has no tool loop for ${seat.modelId} (${seat.provider}) yet`);
    };
    const ledger = new SpendLedger({
      store: new FileLedgerStore(),
      policy: policyFromBudgets(loadBudgets()),
    });
    log(
      "REAL models (each on its own provider), FAKE MCP on SYNTHETIC data: no Blockworks request, no Blockworks data",
    );
    const summary = await runMcpDay({ ...common, seats, ledger, chatFor });
    const all = records.forWindow(f.day.window);
    console.log(`\n${JSON.stringify(summary)}`);
    console.log(
      `trial spend today: $${ledger.report().spentToday} of the $${ledger.report().dailyCapUsd} cap`,
    );
    console.log(
      `\n${dailyTable(all, f.day.window, "MCP mode")}\n${failureReport(all, f.day.window)}`,
    );
    // SYNTHETIC data only, so the details can be shown: what each session did and what it finally said
    for (const r of all) {
      console.log(
        `\n${r.instance} ${r.model}: ${r.mcp?.tool_calls.length ?? 0} tool calls, ${r.mcp?.turns.length ?? 0} turns, snapshot check ${r.mcp?.snapshot_check}${r.mcp?.limit ? `, ended on ${r.mcp.limit}` : ""}${r.mcp?.variant ? `, variant ${r.mcp.variant}` : ""}, stop ${r.stop_reason ?? "-"}, $${r.usd}${r.passed ? "" : `, FAILED (${r.failure_classes.join(", ")})`}`,
      );
      for (const c of r.mcp?.tool_calls ?? [])
        console.log(
          `    turn ${c.turn} ${c.tool} ${JSON.stringify(c.args).slice(0, 170)} -> ${c.is_error ? "ERROR " : ""}${c.result_bytes} bytes`,
        );
      for (const t of r.mcp?.turns ?? [])
        console.log(
          `    turn ${t.turn}: in ${t.input_tokens}, out ${t.output_tokens}, $${t.usd}, stop ${t.stop_reason ?? "-"}`,
        );
      if (!r.passed) {
        for (const fl of r.failures.slice(0, 4))
          console.log(`    gate: ${fl.code}: ${fl.detail.slice(0, 150)}`);
        console.log(`    final text: ${JSON.stringify(r.raw_output.slice(0, 400))}`);
      }
    }
    if (summary.stopped !== undefined) process.exit(3);
  }
} finally {
  f.cleanup();
  rmSync(tmp, { recursive: true, force: true });
}
