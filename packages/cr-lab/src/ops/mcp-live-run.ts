/**
 * The body of a scheduled MCP-mode day (D116): the day's stored snapshot gives the questions, a connection to the live Blockworks MCP gives the models something to research with, and every
 * session goes through the same loop, grader and record as before (`mcp/session.ts`). What this adds is what a live, unattended run needs:
 *
 *  - every tool call is paced by the rate governor's `mcp` group, which waits out its hourly limit rather than stopping, so a day's sessions finish slowly instead of failing;
 *  - a session that met a service failure is not recorded and stops the run (`mcp/incident-guard.ts`), so the provider's outage is not counted against a model;
 *  - the live tool calls are tallied for the day's request ceiling.
 *
 * The connection, the chat for each seat and the stores are given, so a test runs the whole path on the fake server and scripted agents; the entry point builds the real ones.
 */
import { RateGovernor } from "../data-desk/governor.js";
import type { SnapshotStore } from "../data-desk/snapshots.js";
import { AbortOnIncidentStore, InfraWatchMcp } from "../mcp/incident-guard.js";
import { MCP_GOVERNOR_GROUP } from "../mcp/live-mcp.js";
import type { LoopLimits, ToolChat } from "../mcp/anthropic-loop.js";
import { runMcpDay, type RunMcpDaySummary } from "../mcp/session.js";
import type { McpBackend } from "../mcp/types.js";
import type { RecordStore } from "../runner/records.js";
import { daySha256 } from "../runner/run-day.js";
import type { Seat } from "../runner/run-answer.js";
import type { SpendLedger } from "../spend/ledger.js";
import { loadDay } from "../tasks/day-data.js";
import type { TaskId } from "../tasks/instances.js";
import type { SeedBook } from "../tasks/seeds.js";
import type { McpTally } from "./daily-mcp.js";

export interface LiveMcpRunDeps {
  store: SnapshotStore;
  records: RecordStore;
  ledger: SpendLedger;
  seeds: SeedBook;
  seats: readonly Seat[];
  chatFor: (seat: Seat) => ToolChat;
  /** opens the connection, given the governor that must pace it */
  connect: (governor: RateGovernor) => Promise<McpBackend & { close(): Promise<void> }>;
  governor?: RateGovernor;
  tasks?: readonly TaskId[];
  perTask?: number;
  limits?: Partial<LoopLimits>;
  maxSessions?: number;
  sessionsDir?: string;
}

export async function runLiveMcpDay(
  window: string,
  deps: LiveMcpRunDeps,
  log: (line: string) => void,
  tally: McpTally,
): Promise<RunMcpDaySummary> {
  const day = loadDay(deps.store, window);
  if (day.missing.length > 0)
    log(
      `note: the window has no snapshot for: ${day.missing.join(", ")} (those tasks give no instances)`,
    );
  // the hourly limit is waited out, not thrown: a day's sessions are slow by design (D101)
  const governor =
    deps.governor ??
    new RateGovernor({ overrides: { [MCP_GOVERNOR_GROUP]: { waitOnHourlyLimit: true } } });
  const live = await deps.connect(governor);
  const watch = new InfraWatchMcp(live);
  try {
    return await runMcpDay({
      window,
      day,
      daySha256: daySha256(deps.store, window),
      seats: deps.seats,
      ledger: deps.ledger,
      seeds: deps.seeds,
      records: new AbortOnIncidentStore(deps.records, watch),
      mcp: watch,
      chatFor: deps.chatFor,
      ...(deps.tasks !== undefined ? { tasks: deps.tasks } : {}),
      ...(deps.perTask !== undefined ? { perTask: deps.perTask } : {}),
      ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
      ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
      ...(deps.sessionsDir !== undefined ? { sessionsDir: deps.sessionsDir } : {}),
      log,
    });
  } finally {
    tally.requests += governor
      .report()
      .filter((r) => r.group === MCP_GOVERNOR_GROUP)
      .reduce((n, r) => n + r.requestsToday, 0);
    await live.close().catch(() => undefined);
  }
}
