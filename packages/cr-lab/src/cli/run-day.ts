/**
 * Snapshot mode, one window (§16.7).
 *
 *   pnpm --filter @touchstone/cr-lab run run-day                       # FIXTURES: stand-in models on a synthetic day; spends and calls nothing
 *   pnpm --filter @touchstone/cr-lab run run-day -- --live --window 2026-10-17 --models claude-haiku-4-5,claude-sonnet-5 --yes-spend [--part dry-run] [--per-task 1] [--tasks CR-UO,CR-SM] [--max-answers 8] [--concurrency 1]
 *
 * LIVE calls real models with the trial keys (`CR_*` only), on a window whose snapshot is already stored, and spends money: it refuses without `--yes-spend`, and the spend guard in front of every
 * call stops the run at the daily cap or at a provider's budget (and refuses outright for a provider with no recorded balance). It makes no Blockworks request: it reads the stored snapshot.
 * It prints step names, pass or fail, classes and dollars, never a Blockworks figure or a model's reply; the replies and the tables go under the private directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SnapshotStore, defaultStoreOptions } from "../data-desk/snapshots.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore, MemoryLedgerStore } from "../spend/store.js";
import { loadDay } from "../tasks/day-data.js";
import { fixtureDay } from "../tasks/fixture-day.js";
import { TASKS, type TaskId } from "../tasks/instances.js";
import { SeedBook } from "../tasks/seeds.js";
import { FileRecordStore, MemoryRecordStore } from "../runner/records.js";
import { daySha256, runDay, writeTables } from "../runner/run-day.js";
import { buildSeats } from "../runner/seats.js";
import { standInSeat } from "../runner/stand-in-models.js";
import { cumulativeTable, dailyTable, failureReport } from "../runner/tables.js";

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string): string | undefined => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const num = (n: string): number | undefined => {
  const v = opt(n);
  if (v === undefined) return undefined;
  const x = Number(v);
  if (!Number.isInteger(x) || x < 1) throw new Error(`--${n} must be a whole number of at least 1`);
  return x;
};
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (l: string) => console.log(`${stamp()} ${l}`);

const tasksArg = opt("tasks");
const tasks =
  tasksArg === undefined
    ? undefined
    : (tasksArg.split(",").map((t) => {
        if (!(TASKS as readonly string[]).includes(t)) throw new Error(`unknown task ${t}`);
        return t as TaskId;
      }) as TaskId[]);
const part = (opt("part") ?? "snapshot") as "snapshot" | "dry-run";
if (part !== "snapshot" && part !== "dry-run")
  throw new Error("--part must be snapshot or dry-run");

if (!flag("live")) {
  // ---- fixtures: nothing real is touched ----
  const f = await fixtureDay();
  const tmp = mkdtempSync(join(tmpdir(), "cr-run-day-"));
  try {
    const records = new MemoryRecordStore();
    const seats = (["solver", "sloppy", "fenced", "silent"] as const).map((k) => standInSeat(k));
    const summary = await runDay({
      window: f.day.window,
      day: f.day,
      daySha256: daySha256(f.store, f.day.window),
      seats,
      ledger: new SpendLedger({
        store: new MemoryLedgerStore(),
        policy: {
          dailyCapUsd: "9",
          providers: { anthropic: { budgetUsd: "100", since: "2026-01-01T00:00:00Z" } },
        },
      }),
      seeds: new SeedBook({ publicDir: join(tmp, "pub"), privateDir: join(tmp, "priv") }),
      records,
      ...(tasks !== undefined ? { tasks } : {}),
      log,
    });
    const all = records.forWindow(f.day.window);
    console.log(`\nFIXTURES (stand-in models, synthetic data; nothing spent, nothing called)`);
    console.log(JSON.stringify(summary));
    console.log(
      `\n${dailyTable(all, f.day.window)}\n${cumulativeTable(all)}\n${failureReport(all, f.day.window)}`,
    );
  } finally {
    f.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
} else {
  // ---- live ----
  const window = opt("window") ?? new Date().toISOString().slice(0, 10);
  const modelIds = (opt("models") ?? "").split(",").filter((m) => m !== "");
  if (modelIds.length === 0) throw new Error("--live needs --models id[,id...] (registry ids)");
  if (!flag("yes-spend")) {
    console.error(
      `refusing: --live spends real money on ${modelIds.join(", ")}. Add --yes-spend to go ahead; the spend guard still stops the run at the cap or at a provider's budget.`,
    );
    process.exit(2);
  }
  const store = new SnapshotStore(defaultStoreOptions("live"));
  const day = loadDay(store, window);
  if (day.missing.length > 0)
    log(
      `note: the window has no snapshot for: ${day.missing.join(", ")} (those tasks give no instances)`,
    );
  const ledger = new SpendLedger({
    store: new FileLedgerStore(),
    policy: policyFromBudgets(loadBudgets()),
  });
  const records = new FileRecordStore();
  const seats = buildSeats(modelIds);
  const summary = await runDay({
    window,
    day,
    daySha256: daySha256(store, window),
    seats,
    ledger,
    seeds: new SeedBook(),
    records,
    part,
    ...(num("per-task") !== undefined ? { perTask: num("per-task") as number } : {}),
    ...(num("max-answers") !== undefined ? { maxAnswers: num("max-answers") as number } : {}),
    ...(num("concurrency") !== undefined ? { concurrency: num("concurrency") as number } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    log,
  });
  const files = writeTables(records, window, part);
  const r = ledger.report();
  console.log(`\n${JSON.stringify(summary)}`);
  console.log(`trial spend today: $${r.spentToday} of the $${r.dailyCapUsd} cap`);
  console.log(`tables (private): ${files.join(", ")}`);
  if (summary.stopped !== undefined) process.exit(3);
}
