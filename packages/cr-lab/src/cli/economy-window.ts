/**
 * `pnpm --filter @touchstone/cr-lab run economy-window -- [--agents scripted|model] [--model claude-haiku-4-5] [--windows 1] [--rounds 8] [--seed dev-0] [--ledger <path>] [--yes-spend]
 *    [--backend stand-in|snapshot --days 2026-10-17,2026-10-18 --snapshots <private snapshots dir>]`
 *
 * With `--backend snapshot` the issuers do real task work (their own models, through the answer runner and the gates) on the STORED days named by `--days`, one economy window per day;
 * that spends money too, so it needs `--yes-spend` and `--ledger` like model agents do. Stored Blockworks data may be used only until the end of the trial's deletion window.
 *
 * `--counted` runs the COUNTED windows pre-registered in the parameters file (`counted`: the stored days in order, the seats' models rotating by window, settlement): model agents, real issuer
 * work on the stored days, the redemption criterion reported as a finding (the owner, 2026-11-05), and at the end the window journal replayed onto the real contracts on anvil with every
 * balance compared (`--no-replay` skips it). `--agents scripted` with `--counted` is the free rehearsal of the same pipeline (issuer work still costs a little); `--days` narrows the days.
 * A `--counted` run also drops `blind-exits.json` in its own directory when an exit needs a blind tag, and the report points at `economy-score` (`cli/economy-score.ts`) for the
 * pre-registered scoring itself (§16.9, `economy/scoring.ts`) — never run inline here, since the thesis's threshold waits on that blind tag (the owner, 2026-11-07).
 *
 * Runs development windows of the CR economy (`docs/part5-build-plan.md` §6) on the memory ledger and the stand-in backend (labelled on every line; no Blockworks data). Scripted agents
 * spend nothing. Model agents spend real money through the trial's spend ledger: the run refuses without `--yes-spend`, and `--ledger` must name the ledger the trial itself writes, so the
 * $9 daily cap covers both (never run it while another spending process is running: reservations are in-process). Writes the ordered log and the report privately.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { trialKey } from "../keys.js";
import { anthropicChat, anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { openAiChat, openAiChatApi } from "../mcp/openai-loop.js";
import type { ToolChat } from "../mcp/tool-loop.js";
import { replayOnAnvil } from "../economy/chain-replay.js";
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
import { loadParams, PARAMS_PATH } from "../economy/params.js";
import { judgeDevWindows } from "../economy/report.js";
import { exitsToTagBlind } from "../economy/scoring.js";
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

const counted = flag("--counted");
// v2 (redesign items 8-14): --params points at a candidate v2 config for dev-testing, never the committed v1 file in place -- the default stays PARAMS_PATH exactly as
// every pre-existing call site/test already expects, so this is purely additive.
const base = loadParams(arg("--params", PARAMS_PATH));
if (counted && base.counted === undefined)
  throw new Error("--counted needs the `counted` block in the parameters file");
const mode = (arg("--agents") ?? (counted ? "model" : "scripted")) as "scripted" | "model";
const models = (
  arg("--model") ?? (counted ? (base.counted?.seats ?? []).join(",") : "claude-haiku-4-5")
).split(",");
const windows = Number(arg("--windows", "1"));
const seed = arg(
  "--seed",
  `${counted ? "counted" : "dev"}-${new Date().toISOString().slice(0, 10)}`,
) as string;
const rounds = Number(arg("--rounds", String(base.roundsPerWindow)));
const params = { ...base, seed, roundsPerWindow: rounds };

const backend = (counted ? "snapshot" : arg("--backend", "stand-in")) as "stand-in" | "snapshot";
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

const runId = `economy-${counted ? "counted-" : ""}${mode}-${backend}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
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
  const days = (arg("--days") ?? (counted ? (params.counted?.days ?? []).join(",") : ""))
    .split(",")
    .filter((d) => d !== "");
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
let agents: Agent[] | ((k: number) => Agent[]);
if (mode === "scripted") {
  agents = ids.map(
    ([id, role]) => new ScriptedAgent(id, role, id === "RESEARCH-2" ? "ISSUER-X" : "ISSUER-C1"),
  );
} else {
  // each seat model talks to its own provider with the trial's own key; with several models the seats rotate by window (D75: counted windows alternate claude-sonnet-5 and gpt-5.1)
  const { registry, snapshot } = loadRegistryAndPrices();
  const byModel = new Map<string, Agent[]>();
  for (const m of models) {
    const entry = registry.find((r) => r.id === m);
    if (entry === undefined) throw new Error(`"${m}" is not in the model registry`);
    const chat: ToolChat =
      entry.provider === "anthropic"
        ? anthropicChat(anthropicMessagesApi(trialKey("anthropic")), entry.model_string)
        : entry.provider === "openai"
          ? openAiChat(openAiChatApi(trialKey("openai")), entry.model_string)
          : (() => {
              throw new Error(`no agent chat for ${m} (${entry.provider}) yet`);
            })();
    const keyName = entry.provider === "anthropic" ? "CR_ANTHROPIC_API_KEY" : "CR_OPENAI_API_KEY";
    byModel.set(
      m,
      ids.map(
        ([id, role]) =>
          new ModelAgent(id, role, m, chat, priceFor(m, snapshot), ledger as SpendLedger, keyName),
      ),
    );
  }
  agents = (k: number): Agent[] =>
    byModel.get(models[(k - 1) % models.length] as string) as Agent[];
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
  instructions: (role, siuFirst) => instructionsFor(role as Role, siuFirst),
});
const verdict = judgeDevWindows(world, stats, { redemptionIsFinding: counted || mode === "model" });
let report = overview(
  world,
  stats,
  verdict,
  `CR economy ${counted ? "COUNTED" : "development"} run ${runId} (${mode}${mode === "model" ? `, seats ${models.join(" / ")} rotating by window` : ""})`,
);
if (counted || flag("--replay")) {
  if (flag("--no-replay")) report += "\n## On-chain replay\n\n- skipped (--no-replay)\n";
  else {
    const r = await replayOnAnvil(world.chain);
    writeFileSync(
      `${dir}/replay.json`,
      `${JSON.stringify(r, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 1)}\n`,
      { mode: 0o600 },
    );
    report += `\n## On-chain replay (the window journal onto the real contracts on anvil)\n\n- ${r.replayed} of ${r.entries} journal entries in ${r.transactions} transactions; findings ${r.findings.length}; balance differences ${r.diff.length}${r.findings.length === 0 && r.diff.length === 0 ? " — the chain agrees with the memory ledger to the base unit" : ""}\n`;
    for (const f of r.findings)
      report += `- FINDING: ${f.kind} at entry ${f.entry} (${f.op}): ${f.detail}\n`;
    for (const d of r.diff.slice(0, 20))
      report += `- DIFF ${d.what} ${d.key}: memory ${d.memory}, chain ${d.chain}\n`;
  }
}
if (counted) {
  // the pre-registered scoring (§16.9, `scoring.ts`) is never run inline: unclassified exits need a blind human tag before the thesis's 20% threshold can be scored
  // (the owner, 2026-11-07), so this only drops the blind-exit list here (if any) and points at the standalone `economy-score` command for the rest.
  const blind = exitsToTagBlind(world.log.entries);
  if (blind.length > 0) {
    writeFileSync(`${dir}/blind-exits.json`, `${JSON.stringify(blind, null, 1)}\n`, { mode: 0o600 });
    report += `\n## Pre-registered scoring\n\n- ${blind.length} exit(s) need a blind tag before the thesis is scored: see \`${dir}/blind-exits.json\`, then run \`pnpm run economy-score -- --log ${dir}/log.jsonl --tags <tagged file> --out ${dir}/scoring.md\`.\n`;
  } else
    report += `\n## Pre-registered scoring\n\n- run \`pnpm run economy-score -- --log ${dir}/log.jsonl --out ${dir}/scoring.md\` (no exit needs a blind tag this run).\n`;
}
writeFileSync(`${dir}/report.md`, report, { mode: 0o600 });
console.log(report);
console.log(`log and report (private): ${dir}`);
