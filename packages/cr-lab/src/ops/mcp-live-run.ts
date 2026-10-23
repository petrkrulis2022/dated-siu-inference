/**
 * The body of a scheduled MCP-mode day (D116): the day's stored snapshot gives the questions, a connection to the live Blockworks MCP gives the models something to research with, and every
 * session goes through the same loop, grader and record as before (`mcp/session.ts`). What this adds is what a live, unattended run needs:
 *
 *  - every tool call is paced by the rate governor's `mcp` group, which waits out its hourly limit rather than stopping, so a day's sessions finish slowly instead of failing;
 *  - each session is graded against its own answer key, a REST pull taken just before it (`mcp/key-snapshot.ts`, D117), through the same governor's `data-api` group;
 *  - a session that met a service failure is not recorded and stops the run (`mcp/incident-guard.ts`), so the provider's outage is not counted against a model;
 *  - the live tool calls are tallied for the day's request ceiling.
 *
 * The connection, the chat for each seat and the stores are given, so a test runs the whole path on the fake server and scripted agents; the entry point builds the real ones.
 */
import type { DataDesk } from "../data-desk/desk.js";
import { RateGovernor } from "../data-desk/governor.js";
import type { SnapshotStore } from "../data-desk/snapshots.js";
import { AbortOnIncidentStore, InfraWatchMcp } from "../mcp/incident-guard.js";
import { keyTagFor, pullSessionKey } from "../mcp/key-snapshot.js";
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
  /**
   * Opens the connection to the MCP, and the data desk that pulls each session's answer key over REST (D117), both given the one governor that must pace them: the MCP's calls and the
   * key pulls are separate request groups of it, and both count toward the day's ceiling.
   */
  connect: (
    governor: RateGovernor,
  ) => Promise<{ mcp: McpBackend & { close(): Promise<void> }; desk: DataDesk }>;
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
    new RateGovernor({
      // one group for the MCP's calls and the key pulls (D122): the hourly count is the 30 + 30 the two groups had, now counted together
      overrides: { [MCP_GOVERNOR_GROUP]: { waitOnHourlyLimit: true, maxRequestsPerHour: 60 } },
    });
  const { mcp: live, desk } = await deps.connect(governor);
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
      keyFor: (instance, seat) =>
        pullSessionKey({
          desk,
          store: deps.store,
          instance,
          window,
          tag: keyTagFor(instance, seat.modelId, new Date()),
        }),
      ...(deps.tasks !== undefined ? { tasks: deps.tasks } : {}),
      ...(deps.perTask !== undefined ? { perTask: deps.perTask } : {}),
      ...(deps.limits !== undefined ? { limits: deps.limits } : {}),
      ...(deps.maxSessions !== undefined ? { maxSessions: deps.maxSessions } : {}),
      ...(deps.sessionsDir !== undefined ? { sessionsDir: deps.sessionsDir } : {}),
      log,
    });
  } finally {
    // the MCP's calls and the key pulls (Data API), counted together
    tally.requests += governor.report().reduce((n, r) => n + r.requestsToday, 0);
    await live.close().catch(() => undefined);
  }
}
