/**
 * The currency lab, one run: `pnpm run lab-run -- [--scripted] [--seed N] [--window-seconds N] [--max-turns N]
 * [--deployment <file>] [--allow-partial-pool]`. Everything that decides what happens is `lab/run.ts`; this
 * file is only the environment — keys, deployment, providers, the print — and the report on disk.
 *
 * Plan: `docs/marketplace_plan.md`. A scripted run calls no model and is never counted; its report says so.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAdapterFor, loadApiKeysFromEnv, type Adapter } from "@touchstone/harness";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { printDateToUnixDay, seriesForPrint, usdPerSiuToNanoUsdPerSiu } from "../chain/rate-attestation.js";
import { loadGateMarketDeployment } from "../chain/deployment.js";
import { ViemChainReader } from "../chain/reader.js";
import type { RunnerDeps } from "../deps.js";
import { AGENT_IDS, type AgentId } from "../identity/resolve.js";
import { classIdFor, type MintContext } from "../loop/full-run.js";
import { assertAllowancesForRun, readAllowances, RUN_MINIMUM_ALLOWANCE_MINOR_UNITS } from "./allowances.js";
import { DEFAULT_PARAMS, LAB_TRADERS, SEAT_OF, type TraderLabel } from "../lab/economy.js";
import { jobSiu, printNano, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "../lab/money.js";
import { scriptedLabTraders, type ScriptedLabTraders } from "../lab/scripted-traders.js";
import { renderWalk, verifyLabWalk, type WalkReport } from "../lab/verify-walk.js";
import { modelExecutor, referenceExecutor, type WorkExecutor } from "../lab/jobs.js";
import { viemLabChain } from "../lab/operator-chain.js";
import { LAB_MODELS } from "../lab/roster.js";
import { LaunchRefused, runLab, type LabReport } from "../lab/run.js";
import { checkProviders, renderProviderChecks } from "./provider-preflight.js";
import {
  LEDGER_PATH,
  PRICES,
  REPO_ROOT,
  loadLatestCommodityPrint,
  toHex,
  withRetry,
} from "./p5-shared.js";

/**
 * The run's spending cap is enforced against PROJECTED spend, so the projection has to mean something. The first
 * model run projected every turn at the full 4,500-token output allowance, about five times what a turn realizes,
 * and a $3 cap stopped it after about 125 turns having realized $0.69. Traders now project at 600 output tokens (twice
 * the observed maximum; `lab/roster.ts`), about 1.5 times realized, so a cap of 3 allows several hundred turns — more
 * than a full run — and stops a runaway at roughly two real dollars.
 */
const RUN_CAP_USD = "3";
const EXPERIMENT_CAP_USD = "150";
const DEFAULT_DEPLOYMENT = "data/deployments/base-sepolia-gate-market-single-issuer.json";
/** Enough gas for a run's transactions at any gas price Base Sepolia has shown. */
const MIN_ETH_WEI = 20_000_000_000_000n; // 0.00002 ETH
const LAB_RUNS_ROOT = join(REPO_ROOT, "data/lab/runs");

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
  return value;
}

const intFlag = (argv: readonly string[], name: string, fallback: number): number => {
  const raw = flag(argv, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got ${raw}.`);
  return n;
};

const SEATS = ["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "ISSUER-A", "ISSUER-B"] as const;
/**
 * The variable a seat's wallet is read from. TRADER-4 stands on the seat ID `ISSUER-A` with a wallet of its own
 * (plan D22): ISSUER-A is the failing issuer phase 2 brings back and its identity carries every enforcement on
 * record, so the lab never reads `ISSUER_A_*` as a trader's wallet.
 */
const envName = (seat: string, suffix: "ADDRESS" | "PRIVATE_KEY"): string =>
  seat === "ISSUER-A" ? `TRADER_4_${suffix}` : `${seat.replace("-", "_")}_${suffix}`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const scripted = argv.includes("--scripted");
  const seed = intFlag(argv, "--seed", Math.floor(Math.random() * 2_147_483_647));
  const windowSeconds = intFlag(argv, "--window-seconds", scripted ? 420 : 1500);
  const maxTurns = intFlag(argv, "--max-turns", 40);
  const deploymentFile = flag(argv, "--deployment") ?? DEFAULT_DEPLOYMENT;
  const runId = `lab${scripted ? "-scripted" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  console.log(
    scripted
      ? "=== CURRENCY LAB — SCRIPTED WALK (DEBUG: no model is called; none of this counts) ==="
      : "=== CURRENCY LAB — MODEL RUN ===",
  );
  console.log(`Run ${runId}, seed ${seed}, window ${windowSeconds}s, at most ${maxTurns} turns per trader.\n`);

  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8")) as {
    id: string;
    provider: string;
    host: string;
  }[];
  const registryEntry = (id: string): { provider: string; host: string } => {
    const entry = registry.find((r) => r.id === id);
    if (!entry) throw new Error(`"${id}" is not a registered model.`);
    return { provider: entry.provider, host: entry.host };
  };

  const deploymentRecord = JSON.parse(readFileSync(join(REPO_ROOT, deploymentFile), "utf-8"));
  const deployment = loadGateMarketDeployment(deploymentFile);
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  if (rpcUrl === "") throw new Error("BASE_SEPOLIA_RPC_URL is not set.");

  const addresses = Object.fromEntries(SEATS.map((s) => [s, toHex(process.env[envName(s, "ADDRESS")], envName(s, "ADDRESS"))])) as Record<
    (typeof SEATS)[number],
    Hex
  >;
  const keys = Object.fromEntries(SEATS.map((s) => [s, toHex(process.env[envName(s, "PRIVATE_KEY")], envName(s, "PRIVATE_KEY"))])) as Record<
    (typeof SEATS)[number],
    Hex
  >;
  const operatorKey = toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY");
  const operator = { label: "operator", address: privateKeyToAccount(operatorKey).address, privateKeyHex: operatorKey };
  const publisherKey = toHex(process.env.TOUCHSTONE_PUBLISHER_KEY, "TOUCHSTONE_PUBLISHER_KEY");

  // Every trader can pay by minting, so every trader's wallet must have approved this WorkClaim.
  const rows = await readAllowances({
    usdc: deploymentRecord.usdc.address as Hex,
    spender: deploymentRecord.workClaim.address as Hex,
    rpcUrl,
    owners: [
      ...LAB_TRADERS.map((t) => ({
        label: `${t} (${SEAT_OF[t]})`,
        address: addresses[SEAT_OF[t] as (typeof SEATS)[number]],
        minimum: RUN_MINIMUM_ALLOWANCE_MINOR_UNITS.agent,
      })),
      { label: "operator", address: operator.address, minimum: RUN_MINIMUM_ALLOWANCE_MINOR_UNITS.operator },
    ],
  });
  assertAllowancesForRun(rows, `pnpm run approve-roster -- --deployment ${deploymentFile} --lab --execute`);
  console.log("USDC allowances to this deployment's WorkClaim: OK for all four traders and the operator.\n");

  const commodityPrint = loadLatestCommodityPrint();
  const rateUsdPerSiu = commodityPrint.dated_siu;
  console.log(`Real Commodity SIU print ${commodityPrint.print_id}: $${rateUsdPerSiu}/SIU.\n`);

  const apiKeys = scripted ? {} : loadApiKeysFromEnv();
  const models = LAB_MODELS;
  const unpriced = Object.values(models).filter((m) => PRICES[m] === undefined);
  if (!scripted && unpriced.length > 0) {
    throw new Error(`No PRICES entry for: ${[...new Set(unpriced)].join(", ")}. Add it to p5-shared.ts from the latest price snapshot.`);
  }

  let adapters: Record<TraderLabel, Adapter>;
  const issuerAdapter: Adapter | undefined = undefined; // the production issuer service, in every mode
  let executorFor: (t: TraderLabel) => WorkExecutor;
  let scriptedTraders: ScriptedLabTraders | undefined;
  if (scripted) {
    const p = printNano(rateUsdPerSiu);
    scriptedTraders = scriptedLabTraders({
      print: { printId: commodityPrint.print_id, printHash: "0x00", rateUsdPerSiu, indexVersion: "SIU-2026a" },
      rates: { trade: tradeRateUsdPerSiu(p, DEFAULT_PARAMS), raw: rawWorkRateUsdPerSiu(p) },
      sizeSiu: jobSiu(DEFAULT_PARAMS),
      chain: "base-sepolia",
      quoteExpirySeconds: windowSeconds,
      printNano: p,
    });
    adapters = scriptedTraders.adapters;
    // A scripted job passes: the walk is about the plumbing, not the extraction.
    executorFor = () => referenceExecutor;
    console.log("Providers: none to check — a scripted run calls no model.\n");
  } else {
    adapters = Object.fromEntries(LAB_TRADERS.map((t) => [t, withRetry(createAdapterFor(registryEntry(models[t]), apiKeys))])) as Record<TraderLabel, Adapter>;
    // One real call per provider, through the run's own adapter: key, organisation and balance together.
    const byProvider = new Map<string, { model: string; adapter: Adapter }>();
    for (const t of LAB_TRADERS) {
      const provider = registryEntry(models[t]).provider;
      if (!byProvider.has(provider)) byProvider.set(provider, { model: models[t], adapter: adapters[t] });
    }
    const checks = await checkProviders(byProvider);
    console.log(renderProviderChecks(checks));
    const dead = checks.filter((c) => !c.ok);
    if (dead.length > 0) {
      console.log(`\nABORTING BEFORE SPENDING ANYTHING: ${dead.map((d) => d.provider).join(", ")} cannot answer.`);
      process.exit(1);
    }
    console.log("");
    executorFor = (t) => modelExecutor({ adapter: adapters[t], modelString: models[t], prices: PRICES[models[t]] });
  }

  const chainReader = new ViemChainReader(deployment, rpcUrl);
  const escrowFromRecord = deploymentRecord.escrow.address as string;
  const escrowFromEnv = process.env.TOUCHSTONE_ESCROW_ADDRESS;
  if (escrowFromEnv !== undefined && escrowFromEnv.toLowerCase() !== escrowFromRecord.toLowerCase()) {
    throw new Error(
      `TOUCHSTONE_ESCROW_ADDRESS (${escrowFromEnv}) is not the escrow this deployment's WorkClaim reads (${escrowFromRecord}).`,
    );
  }
  const escrowAddress = escrowFromRecord;
  const escrowFeeBps = await chainReader.escrowFeeBps(escrowAddress as Hex);
  console.log(
    `The escrow keeps ${escrowFeeBps} bps of a dollar settlement. The operator gives it back to the seller after each one, ` +
      "so the two routes cost the same; the brief does not mention it.\n",
  );

  const series = seriesForPrint(commodityPrint.series);
  const printDate = printDateToUnixDay(commodityPrint.date);
  const nanoUsdPerSiu = usdPerSiuToNanoUsdPerSiu(rateUsdPerSiu);
  const mintContext: MintContext = {
    publisherPrivateKeyHex: publisherKey,
    printId: commodityPrint.print_id,
    series,
    printDate,
    nanoUsdPerSiu,
    validitySeconds: 3600n,
  };

  const budget = new ExperimentBudget({
    ceiling: new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id: AgentId) => [id, { maxUsdcSpend: "1", maxInferenceTurns: maxTurns * 2, maxInferenceUsd: id === "HEDGER" ? "0" : "1.5" }]),
      ) as never,
    ),
    runCapUsd: RUN_CAP_USD,
    experimentCapUsd: EXPERIMENT_CAP_USD,
    ledgerPath: LEDGER_PATH,
  });
  const loopDeps: RunnerDeps = {
    chainReader,
    deployment,
    escrowAddress,
    runGateHardeningChecks: async () => {
      throw new Error("a lab run has no gate");
    },
    loadPrint: async () => commodityPrint,
    isReconciled: async () => false,
  };

  mkdirSync(LAB_RUNS_ROOT, { recursive: true });
  // Written the moment the endowment exists, so a run killed outright can still be cleaned up (`lab-sweep`).
  const openPath = join(LAB_RUNS_ROOT, `${runId}-open.json`);
  let report: LabReport;
  try {
    report = await runLab({
      seed,
      runId,
      scripted,
      print: { printId: commodityPrint.print_id, rateUsdPerSiu },
      chain: viemLabChain({ deployment, rpcUrl, operator, publisherKeyHex: publisherKey, print: { printId: commodityPrint.print_id, series, printDate, nanoUsdPerSiu } }),
      classId: classIdFor("extract") as Hex,
      addresses,
      keys,
      operator,
      issuerLimitMilliSiu: BigInt(deploymentRecord.capacityLots["ISSUER-B"].issuanceLimitPerClass),
      allowPartialPool: argv.includes("--allow-partial-pool"),
      // The real ISSUER-A (if this environment has one) must never be a trader's wallet.
      ...(process.env.ISSUER_A_ADDRESS !== undefined && process.env.ISSUER_A_ADDRESS !== ""
        ? { forbiddenAddresses: { "ISSUER-A": toHex(process.env.ISSUER_A_ADDRESS, "ISSUER_A_ADDRESS") } }
        : {}),
      windowSeconds,
      escrowFeeBps,
      maxTurns,
      chainName: "base-sepolia",
      rpcUrl,
      adapters,
      models,
      // A scripted seat costs nothing, and projecting a model's price for it would spend the cap on a call never made.
      prices: scripted
        ? Object.fromEntries(Object.values(models).map((m) => [m, { priceInUsdPer1M: "0", priceOutUsdPer1M: "0" }]))
        : PRICES,
      providerOf: (m) => registryEntry(m).provider,
      executorFor,
      ...(issuerAdapter !== undefined ? { issuerAdapter } : {}),
      loopDeps,
      budget,
      runsRoot: LAB_RUNS_ROOT,
      mintContext,
      minEthWei: MIN_ETH_WEI,
      onMinted: (open) => writeFileSync(openPath, `${JSON.stringify({ ...open, swept: false }, null, 2)}\n`),
      log: (line) => console.log(line),
      onTurn: (agentId, turn) => {
        const t = turn as { turn: number; projectedUsd: string; realizedUsd: string; latencyMs: number; parsed: string };
        console.log(
          `[${agentId}] Turn ${t.turn}: projected=$${t.projectedUsd}, realized=$${t.realizedUsd}, ${t.latencyMs}ms -> ${t.parsed.slice(0, 220)}`,
        );
      },
    });
  } catch (err) {
    if (err instanceof LaunchRefused) {
      console.log(`\n${err.message}\nNothing was spent, minted or moved.`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // The run swept its own capacity: the record of what was open is closed.
  if (report.pool.restored === true && existsSync(openPath)) {
    const open = JSON.parse(readFileSync(openPath, "utf-8"));
    writeFileSync(openPath, `${JSON.stringify({ ...open, swept: true }, null, 2)}\n`);
  }
  const reportPath = join(LAB_RUNS_ROOT, `${runId}-report.json`);
  // A scripted walk is only worth having if what it was for actually happened, and a script that issued its
  // calls proves only that. The verifier reads the recorded events; a failed check fails the process.
  const walk =
    scriptedTraders !== undefined
      ? verifyLabWalk(JSON.parse(JSON.stringify(report)) as unknown as WalkReport, scriptedTraders.status())
      : undefined;
  writeFileSync(
    reportPath,
    `${JSON.stringify(walk !== undefined ? { ...report, scriptedWalk: { ...walk, steps: scriptedTraders!.status() } } : report, null, 2)}\n`,
  );
  console.log(`\nMachine-readable report written to ${reportPath}`);
  printSummary(report);
  if (walk !== undefined) {
    console.log(`\n${renderWalk(walk)}`);
    if (!walk.ok) process.exitCode = 1;
  }
  if (report.abortedBecause !== undefined || report.pool.restored === false) process.exitCode = 1;
}

function printSummary(r: LabReport): void {
  console.log("\n=== RESULT ===");
  const final = r.final as { traders: { trader: string; usdcMinor: string; fsiuMilliSiu: string; needsMet: number; resultNano: string }[] } | undefined;
  if (final === undefined) console.log("  no scoring snapshot was taken.");
  else {
    const opening = r.snapshots[0] as { traders: { trader: string; resultNano: string }[] };
    for (const t of final.traders) {
      const before = opening.traders.find((o) => o.trader === t.trader)!.resultNano;
      console.log(
        `  ${t.trader}: ${t.needsMet} needs met; USDC ${t.usdcMinor} minor, fSIU ${t.fsiuMilliSiu} mSIU; ` +
          `result ${t.resultNano} nano-USD (opened at ${before}).`,
      );
    }
  }
  console.log(
    `  inference $${r.totalRealizedUsd}, graded work $${r.workCostUsd}; pool ${r.pool.restored ? "restored" : "NOT restored"} ` +
      `(${r.pool.startingHeadroomMilliSiu} -> ${r.pool.endingHeadroomMilliSiu ?? "?"} mSIU).`,
  );
  if (r.contamination !== undefined) console.log(`  CONTAMINATION: ${r.contamination}`);
  if (r.abortedBecause !== undefined) console.log(`  ABORTED: ${r.abortedBecause}`);
  if (r.labErrors.length > 0) console.log(`  ${r.labErrors.length} bookkeeping error(s) of the harness's own — see the report.`);
  if (r.scripted) console.log("  SCRIPTED: no model was called, and this run is never counted.");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
