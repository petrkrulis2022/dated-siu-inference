/**
 * `pnpm --filter @touchstone/cr-lab run v3a-window -- --params <v3a params> --arm A|B --vol low|high --price-seed <seed> [--cell <counted cell>]
 *    [--agents scripted|model] [--model <id, default the config's dev seat>] [--seed <run seed>] [--windows 8] [--yes-spend --ledger <path> [--budgets <path>]]`
 *
 * Runs v3a (docs/experiment-3a-design.md): 9 model agents (or their scripted stand-ins, free), 8 windows of 8 rounds, the stand-in issuers at the committed pass rates, the
 * seeded price path. The price seed is never written into the log until the run has ended (genesis records only its hash); with `--cell` the seed's hash must match the
 * one frozen in the parameters file for that counted cell, or the run refuses to start.
 *
 * Model agents spend real money through the trial's spend ledger, exactly as `economy-window` does: the run refuses without `--yes-spend`, `--ledger` must name the
 * ledger the trial writes, and `--budgets` can point at a scoped budgets file whose cap stops the run (a rehearsal's own dollar cap). Writes privately: the ordered log,
 * the report (validity gates, lost turns, cost, mechanics, NAV by window, this run's own measures, the overview of payments with the agents' reasons) and the sample
 * boards every agent saw at window 3, round 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { D } from "@touchstone/sdk";
import { trialKey } from "../keys.js";
import { anthropicChat, anthropicMessagesApi } from "../mcp/anthropic-loop.js";
import { openAiChat, openAiChatApi } from "../mcp/openai-loop.js";
import type { ToolChat } from "../mcp/tool-loop.js";
import { privatePath } from "../paths.js";
import { loadRegistryAndPrices, priceFor } from "../runner/prices.js";
import { loadBudgets, policyFromBudgets } from "../spend/budgets.js";
import { SpendLedger } from "../spend/ledger.js";
import { FileLedgerStore } from "../spend/store.js";
import type { Agent } from "../economy/agents.js";
import { ScriptedV3aAgent } from "../economy/agents-v3a.js";
import { EconomyLog } from "../economy/log.js";
import { instructionsForV3a, ModelAgent } from "../economy/model-agent.js";
import { overview } from "../economy/overview.js";
import { loadParams } from "../economy/params.js";
import { judgeDevWindows } from "../economy/report.js";
import { loadCrPrint, loadV3aPassRates, runWindows, StopRule, type WindowStats } from "../economy/runner.js";
import { checkGates, gatesPass } from "../economy/v3a-gates.js";
import { renderArmScore, scoreArm } from "../economy/v3a-measures.js";
import { buildV3aWorld, v3aAgentIds } from "../economy/v3a-run.js";
import { AGU_ISSUER, type Role } from "../economy/world.js";

const arg = (name: string, dflt?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);
const need = (name: string, what: string): string => {
  const v = arg(name);
  if (v === undefined) {
    console.error(`--${name} ${what} is required`);
    process.exit(2);
  }
  return v;
};

const paramsPath = need("params", "<the v3a parameters file>");
const arm = need("arm", "A|B");
const vol = need("vol", "low|high");
if (arm !== "A" && arm !== "B") throw new Error("--arm must be A or B");
if (vol !== "low" && vol !== "high") throw new Error("--vol must be low or high");
const priceSeed = arg("price-seed") ?? (arg("price-seed-file") !== undefined ? readFileSync(arg("price-seed-file") as string, "utf-8").trim() : undefined);
if (priceSeed === undefined) {
  console.error("--price-seed <seed> (or --price-seed-file <path>) is required; it is written into the log only once the run has ended");
  process.exit(2);
}
const cell = arg("cell");
const base = loadParams(paramsPath);
if (base.v3a === undefined) throw new Error(`${paramsPath} is not a v3a parameters file`);
const v3a = base.v3a;
const mode = (arg("agents") ?? "scripted") as "scripted" | "model";
const model = arg("model") ?? v3a.seats.dev;
const windowCount = Number(arg("windows", String(v3a.windows)));
const seed = arg("seed", `v3a-${mode}-${new Date().toISOString().slice(0, 10)}`) as string;
const params = { ...base, seed };

const spends = mode === "model";
if (spends && !flag("yes-spend")) {
  console.error("model agents spend real money: add --yes-spend (and --ledger <the trial's ledger>)");
  process.exit(2);
}
const ledgerPath = arg("ledger");
if (spends && ledgerPath === undefined) {
  console.error("--ledger <path> is required with model agents, so the trial's daily cap covers this run too");
  process.exit(2);
}
const ledger = spends
  ? new SpendLedger({ store: new FileLedgerStore(ledgerPath as string), policy: policyFromBudgets(loadBudgets(arg("budgets"))) })
  : undefined;

const runId = `v3a-${mode}-arm${arm}-${vol}${cell !== undefined ? `-${cell}` : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const dir = privatePath("cr", "economy", runId);
mkdirSync(dir, { recursive: true });
const log = new EconomyLog("stand-in", `${dir}/log.jsonl`);
const T0 = Math.floor(Date.UTC(2026, 10, 16) / 1000); // v3a's own calendar: a fixed midnight, so a seed replays exactly
const { world, needsFor } = buildV3aWorld({
  params,
  wp0: loadCrPrint(),
  log,
  t0: T0,
  arm,
  volatility: vol,
  priceSeed,
  ...(cell !== undefined ? { cell } : {}),
});

const ids = v3aAgentIds(params);
let agents: Agent[];
if (mode === "scripted") agents = ids.map(([id, role]) => new ScriptedV3aAgent(id, role));
else {
  const { registry, snapshot } = loadRegistryAndPrices();
  const entry = registry.find((r) => r.id === model);
  if (entry === undefined) throw new Error(`"${model}" is not in the model registry`);
  const chat: ToolChat =
    entry.provider === "anthropic"
      ? anthropicChat(anthropicMessagesApi(trialKey("anthropic")), entry.model_string)
      : entry.provider === "openai"
        ? openAiChat(openAiChatApi(trialKey("openai")), entry.model_string)
        : (() => {
            throw new Error(`no agent chat for ${model} (${entry.provider}) yet`);
          })();
  const keyName = entry.provider === "anthropic" ? "CR_ANTHROPIC_API_KEY" : "CR_OPENAI_API_KEY";
  agents = ids.map(([id, role]) => new ModelAgent(id, role, model, chat, priceFor(model, snapshot), ledger as SpendLedger, keyName));
}

let stats: WindowStats[] = [];
let stopped: string | undefined;
try {
  stats = await runWindows({
    world,
    agents,
    windows: Array.from({ length: windowCount }, (_, i) => i + 1),
    needsFor,
    instructions: (role, siuFirst) => instructionsForV3a(role as Role, siuFirst, v3a.failedWorkPays),
  });
} catch (e) {
  if (!(e instanceof StopRule) && !(e instanceof Error && e.name === "SpendStopped")) throw e;
  stopped = `${e.name}: ${e.message}`;
}
// the run has ended: only now does its price seed go into the log, so anyone can regenerate the path from it
log.write(world.dayLabel(world.window), world.round, AGU_ISSUER, "price", { revealedPriceSeed: priceSeed });

const L = log.entries;
const of = (k: string) => L.filter((e) => e.kind === k);
const gates = checkGates(L, params, cell !== undefined ? { cell } : {});
const cost = stats.reduce((s, x) => s.plus(x.agentCostUsd), new D(0));
const refusals = new Map<string, number>();
for (const t of of("turn"))
  if (t.parsed === true && t.ok === false) {
    const why = String(t.note).replace(/^(?:quote|need|offer|request)-\d+: /, "").replace(/\d[\d,.]*/g, "N").slice(0, 90);
    refusals.set(`${String(t.tool)}: ${why}`, (refusals.get(`${String(t.tool)}: ${why}`) ?? 0) + 1);
  }
const nav = of("nav")
  .filter((_, i, all) => i === all.length - 1 || all[i + 1]?.window !== all[i]?.window)
  .map((e) => `${e.window} ${e.reserveNav} (with buffer ${e.navWithBuffer}, buffer ${e.bufferUsdc} µ$)`);
const closes = of("claim-close").filter((e) => e.reserveLot !== true);
let report = `# v3a ${stopped !== undefined ? "STOPPED" : "run"} ${runId}\n\n`;
report += `- ${mode} agents${mode === "model" ? ` (${model})` : ""}; arm ${arm}; ${vol} volatility; run seed ${seed}; ${windowCount} windows${cell !== undefined ? `; counted cell ${cell}` : " (not a counted cell)"}\n`;
if (stopped !== undefined) report += `- **stopped: ${stopped}**\n`;
report += `- model cost $${cost.toFixed(4)}\n\n## Validity gates — ${gatesPass(gates) ? "ALL PASS" : "FAILED (the run is invalid; never rerun quietly)"}\n\n`;
for (const g of gates) report += `- ${g.ok ? "PASS" : "FAIL"} ${g.name}: ${g.detail}\n`;
report += `\n## Mechanics\n\n`;
report += `- PROVIDER: ${of("offer").filter((e) => e.withdrawn !== true).length} offers posted (${of("offer").filter((e) => e.replaces !== undefined).length} revisions, ${of("offer").filter((e) => e.withdrawn === true).length} withdrawals); ${of("claim-request").filter((e) => e.declined !== true).length} requests, ${of("claim-request").filter((e) => e.declined === true).length} declined; ${of("claim-mint").filter((e) => e.offer !== undefined).length} sales\n`;
report += `- briefs: ${of("gate").filter((e) => e.brief !== undefined && e.passed === true).length} passed, ${of("gate").filter((e) => e.brief !== undefined && e.passed === false).length} failed; ${of("claim-transfer").length} claim transfers as payment\n`;
report += `- claims in agents' hands at close: ${closes.filter((e) => e.outcome === "defaulted").length} defaulted, ${closes.filter((e) => e.outcome === "expired").length} expired\n`;
report += `- sweeps: ${of("sweep").length}, ${of("sweep").filter((e) => (e.forcedAgu as bigint) > 0n).length} needing a forced AGU-lab sale, ${of("sweep").filter((e) => (e.shortfall as bigint) > 0n).length} short\n`;
report += `- arm B rule checks: ${of("rule-check").length} (${of("rule-check").filter((e) => e.compliant === true).length} compliant)\n`;
report += `- AGU-lab NAV at each window's close: ${nav.join("; ")}\n`;
report += `- refusals by kind: ${refusals.size === 0 ? "none" : [...refusals].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n}× ${k}`).join("; ")}\n\n`;
report += `## This run's measures (one run: indicative only; the verdict pools every run of an arm, and the account measure waits on blind coding)\n\n`;
report += renderArmScore(scoreArm(arm, [{ label: runId, log: L }], params, loadV3aPassRates(params)));
report += `\n${overview(world, stats, judgeDevWindows(world, stats, { redemptionIsFinding: true }), `v3a ${runId}`)}`;
const boards = of("board");
const sample = ["provider", "research", "demand", "hedger"]
  .map((role) => boards.find((b) => b.role === role))
  .filter((b) => b !== undefined)
  .map((b) => `## ${String(b?.actor)} (${String(b?.role)}), window 3, round 0\n\n\`\`\`\n${String(b?.text)}\n\`\`\`\n`)
  .join("\n");
writeFileSync(`${dir}/report.md`, report, { mode: 0o600 });
writeFileSync(`${dir}/boards.md`, `# Sample boards, ${runId}\n\n${sample}`, { mode: 0o600 });
console.log(report);
console.log(`log, report and sample boards (private): ${dir}`);
process.exitCode = stopped === undefined && gatesPass(gates) ? 0 : 1;
