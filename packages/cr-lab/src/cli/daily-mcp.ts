/**
 * The scheduled MCP-mode day (D116): what the scheduler runs, hourly, after the day's snapshot is in. It plays the day's missing sessions against the LIVE Blockworks MCP, with the stored
 * login, and spends money on the trial's Anthropic key (each session has its own cap, and the spend guard stops the run at the daily cap or a provider's budget).
 *
 *   node --env-file=../../.env dist/cli/daily-mcp.js --yes-spend [--max-sessions 1]   the hourly run; refuses without --yes-spend
 *   node --env-file=../../.env dist/cli/daily-mcp.js --watchdog                       the evening check: alerts if the day has a complete snapshot but not all its sessions
 *
 * `--max-sessions N`, `--tasks CR-SM[,..]` and `--models id[,..]` restrict one run (the supervised first live session uses them); such a run NEVER marks the day complete, so the next
 * unrestricted run plays the rest, and a session already recorded is not played again.
 * Prints step names, pass or fail and dollars, never a Blockworks figure or a model's reply; the sessions and tables go under the private directory.
 * Exit status: 0 for complete, partial, already complete, waiting for the snapshot, or another run holding the lock; 1 for a failure, a stop or a watchdog alert.
 */
import { SnapshotStore, defaultStoreOptions } from "../data-desk/snapshots.js";
import { BLOCKWORKS_MCP_URL, LiveMcp, McpLoginRequired } from "../mcp/live-mcp.js";
import { DEFAULT_LOGIN_PORT, TrialOAuthProvider } from "../mcp/oauth-store.js";
import { chatForSeats } from "../mcp/seat-chat.js";
import { privatePath } from "../paths.js";
import { FileRecordStore } from "../runner/records.js";
import { writeTables } from "../runner/run-day.js";
import { buildSeats } from "../runner/seats.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";
import { SeedBook } from "../tasks/seeds.js";
import {
  CompositeAlertSink,
  FileAlertSink,
  ToastAlertSink,
  emailSinkFromEnv,
} from "../ops/alert.js";
import { MCP_MODELS, runDailyMcp } from "../ops/daily-mcp.js";
import { MCP_TASKS } from "../mcp/session.js";
import type { TaskId } from "../tasks/instances.js";
import { runLiveMcpDay } from "../ops/mcp-live-run.js";
import { StatusStore } from "../ops/status.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (l: string) => console.log(`${stamp()}Z ${l}`);

const mode = flag("watchdog") ? "watchdog" : "run";
if (mode === "run" && !flag("yes-spend")) {
  console.error(
    "refusing: this plays model sessions against the live Blockworks MCP and spends money on the trial's Anthropic key. Add --yes-spend to go ahead; the spend guard still stops it at the daily cap or at a budget, and every session has its own cap.",
  );
  process.exit(2);
}
const maxSessions = opt("max-sessions") !== undefined ? Number(opt("max-sessions")) : undefined;
if (maxSessions !== undefined && (!Number.isInteger(maxSessions) || maxSessions < 1))
  throw new Error("--max-sessions must be a whole number of at least 1");
const tasks = opt("tasks")
  ?.split(",")
  .map((t) => {
    if (!(MCP_TASKS as readonly string[]).includes(t))
      throw new Error(`--tasks: ${t} is not an MCP-mode task (${MCP_TASKS.join(", ")})`);
    return t as TaskId;
  });
const models = opt("models")
  ?.split(",")
  .filter((m) => m !== "");
if (models !== undefined && models.some((m) => !MCP_MODELS.includes(m)))
  throw new Error(`--models: only the scheduled models can be played (${MCP_MODELS.join(", ")})`);
const restricted = maxSessions !== undefined || tasks !== undefined || models !== undefined;

log(`daily-mcp (${mode}) starting`);
const email = emailSinkFromEnv();
log(
  email.sink !== undefined
    ? "alert email: on"
    : `alert email: off (not set in .env: ${email.missing.join(", ")})`,
);

const records = new FileRecordStore();
const provider = new TrialOAuthProvider({
  redirectUrl: `http://127.0.0.1:${DEFAULT_LOGIN_PORT}/callback`,
});
const { outcome, window } = await runDailyMcp({
  mode,
  status: new StatusStore(privatePath("cr", "mcp-status")),
  snapshotStatus: new StatusStore(),
  alerts: new CompositeAlertSink(
    [new FileAlertSink(), ...(email.sink !== undefined ? [email.sink] : []), new ToastAlertSink()],
    (sink, reason) => log(`alert sink ${sink} failed: ${reason}`),
  ),
  lockPath: privatePath("cr", "locks", "blockworks-live.lock"),
  isLoginRequired: (e) => e instanceof McpLoginRequired,
  run: async (w, l, tally) => {
    const seats = buildSeats(models ?? MCP_MODELS);
    const summary = await runLiveMcpDay(
      w,
      {
        store: new SnapshotStore(defaultStoreOptions("live")),
        records,
        ledger: new SpendLedger({
          store: new FileLedgerStore(),
          policy: policyFromBudgets(loadBudgets()),
        }),
        seeds: new SeedBook(),
        seats,
        chatFor: chatForSeats(seats),
        connect: async (governor) => {
          if (!provider.describe().signedIn) throw new McpLoginRequired();
          return LiveMcp.connect({ url: BLOCKWORKS_MCP_URL, provider, governor });
        },
        ...(maxSessions !== undefined ? { maxSessions } : {}),
        ...(tasks !== undefined ? { tasks } : {}),
      },
      l,
      tally,
    );
    // a restricted run plans only its own sessions, so "all planned sessions recorded" would wrongly close the day
    return restricted ? { ...summary, complete: false } : summary;
  },
  log,
});
if (outcome === "complete" || outcome === "partial") {
  const files = writeTables(records, window, "mcp");
  log(`tables (private): ${files.join(", ")}`);
}
log(`daily-mcp ${window}: ${outcome}`);
process.exit(
  [
    "failed",
    "login-required",
    "spend-stopped",
    "request-ceiling",
    "attempts-exhausted",
    "watchdog-alert",
  ].includes(outcome)
    ? 1
    : 0,
);
