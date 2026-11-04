/**
 * `pnpm --filter @touchstone/cr-lab run economy-window -- [--agents scripted|model] [--model claude-haiku-4-5] [--windows 1] [--rounds 8] [--seed dev-0] [--ledger <path>] [--yes-spend]
 *    [--backend stand-in|snapshot --days 2026-10-17,2026-10-18 --snapshots <private snapshots dir>]`
 *
 * With `--backend snapshot` the issuers do real task work (their own models, through the answer runner and the gates) on the STORED days named by `--days`, one economy window per day;
 * that spends money too, so it needs `--yes-spend` and `--ledger` like model agents do. Stored Blockworks data may be used only until the end of the trial's deletion window.
 *
 * Runs development windows of the CR economy (`docs/part5-build-plan.md` §6) on the memory ledger and the stand-in backend (labelled on every line; no Blockworks data). Scripted agents
 * spend nothing. Model agents spend real money through the trial's spend ledger: the run refuses without `--yes-spend`, and `--ledger` must name the ledger the trial itself writes, so the
 * $9 daily cap covers both (never run it while another spending process is running: reservations are in-process). Writes the ordered log and the report privately.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { trialKey } from "../keys.js";
import { anthropicChat, anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { privatePath } from "../paths.js";
import { loadRegistryAndPrices, priceFor } from "../runner/prices.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";
import { TASKS } from "../tasks/instances.js";
import { ScriptedAgent, StandInWorker, type Agent } from "../economy/agents.js";
import { loadStoredDays, SnapshotModelWorker } from "../economy/snapshot-worker.js";
import type { TaskWorker } from "../economy/world.js";
import { SnapshotStore } from "../data-desk/snapshots.js";
import { buildSeats } from "../runner/seats.js";
import { EconomyLog } from "../economy/log.js";
import { instructionsFor, ModelAgent } from "../economy/model-agent.js";
import { overview } from "../economy/overview.js";
import { loadParams } from "../economy/params.js";
import { judgeDevWindows } from "../economy/report.js";
import {
  buildWorld,
  loadCrPrint,
  needsSchedule,
  passRates,
  runWindows,
  standInSha,
} from "../economy/runner.js";
import type { Role } from "../economy/world.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name: string): boolean => process.argv.includes(name);

const mode = arg("--agents", "scripted") as "scripted" | "model";
const model = arg("--model", "claude-haiku-4-5") as string;
const windows = Number(arg("--windows", "1"));
const seed = arg("--seed", `dev-${new Date().toISOString().slice(0, 10)}`) as string;
const base = loadParams();
const rounds = Number(arg("--rounds", String(base.roundsPerWindow)));
const params = { ...base, seed, roundsPerWindow: rounds };

const backend = arg("--backend", "stand-in") as "stand-in" | "snapshot";
const spends = mode === "model" || backend === "snapshot";
if (spends && !flag("--yes-spend")) {
  console.error(
    "model agents spend real money: add --yes-spend (and --ledger <the trial's ledger>)",
  );
  process.exit(2);
}
const ledgerPath = arg("--ledger");
if (spends && ledgerPath === undefined) {
  console.error(
    "--ledger <path> is required with model agents, so the trial's $9 daily cap covers this run too",
  );
  process.exit(2);
}

const runId = `economy-${mode}-${backend}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const dir = privatePath("cr", "economy", runId);
mkdirSync(dir, { recursive: true });
const wp0 = loadCrPrint();
const T0 = Math.floor(Date.UTC(2026, 10, 2) / 1000); // the economy's own calendar starts on a fixed midnight, so a seed replays exactly
const ledger = spends
  ? new SpendLedger({
      store: new FileLedgerStore(ledgerPath as string),
      policy: policyFromBudgets(loadBudgets()),
    })
  : undefined;
let worker: TaskWorker;
let dataSha: (k: number) => string;
let windowCount = windows;
if (backend === "snapshot") {
  const days = (arg("--days") ?? "").split(",").filter((d) => d !== "");
  if (days.length === 0) throw new Error("--backend snapshot needs --days");
  const dir = arg("--snapshots");
  if (dir === undefined)
    throw new Error("--backend snapshot needs --snapshots <the stored snapshots directory>");
  const store = new SnapshotStore({
    privateRoot: dir,
    manifestDir: arg("--manifests", dir) as string,
    backend: "live",
  });
  const stored = loadStoredDays(store, days);
  const issuerModels = [...new Set(params.issuers.map((i) => i.model))];
  const seats = new Map(buildSeats(issuerModels).map((x) => [x.modelId, x]));
  const w = new SnapshotModelWorker(
    new Map(stored.map((d, i) => [i + 1, d])),
    seats,
    ledger as SpendLedger,
    seed,
  );
  worker = w;
  dataSha = (k) => w.dataSha(k);
  windowCount = days.length;
} else {
  const sha = standInSha(seed);
  worker = new StandInWorker(seed, passRates(wp0), sha);
  dataSha = sha;
}
const log = new EconomyLog(backend, `${dir}/log.jsonl`);
const world = buildWorld({ params, wp0, log, worker, t0: T0, dataSha });
world.genesis();
world.checkInvariants();

const ids: [string, Role][] = [
  ...params.agents.research.map((a): [string, Role] => [a, "research"]),
  ...params.agents.demand.map((a): [string, Role] => [a, "demand"]),
  [params.agents.hedger, "hedger"],
];
let agents: Agent[];
if (mode === "scripted") {
  agents = ids.map(
    ([id, role]) => new ScriptedAgent(id, role, id === "RESEARCH-2" ? "ISSUER-X" : "ISSUER-C1"),
  );
} else {
  const { snapshot } = loadRegistryAndPrices();
  const price = priceFor(model, snapshot);
  const ledger = new SpendLedger({
    store: new FileLedgerStore(ledgerPath as string),
    policy: policyFromBudgets(loadBudgets()),
  });
  const chat = anthropicChat(anthropicMessagesApi(trialKey("anthropic")), model);
  agents = ids.map(
    ([id, role]) => new ModelAgent(id, role, model, chat, price, ledger, "CR_ANTHROPIC_API_KEY"),
  );
}

const ks = Array.from({ length: windowCount }, (_, i) => i + 1);
const stats = await runWindows({
  world,
  agents,
  windows: ks,
  needsFor: needsSchedule(
    seed,
    TASKS.filter((t) => t !== "CR-VS"),
  ),
  instructions: (role) => instructionsFor(role as Role),
});
const verdict = judgeDevWindows(world, stats);
const report = overview(
  world,
  stats,
  verdict,
  `CR economy development run ${runId} (${mode}${mode === "model" ? `, ${model}` : ""})`,
);
writeFileSync(`${dir}/report.md`, report, { mode: 0o600 });
console.log(report);
console.log(`log and report (private): ${dir}`);
