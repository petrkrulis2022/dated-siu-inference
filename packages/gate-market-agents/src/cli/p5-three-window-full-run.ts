import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  stringToBytes,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
import {
  CODE_GATE_1_TRIVIAL,
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_HELD_OUT_INSTANCES,
  runGateHardeningChecks,
} from "@touchstone/task-pack-gate-hardening";
import type { HeldOutInstance } from "@touchstone/task-pack-gate-hardening";
import {
  printDateToUnixDay,
  seriesForPrint,
  signRateAttestation,
  usdPerSiuToNanoUsdPerSiu,
} from "../chain/rate-attestation.js";
import { WORK_CLAIM_ABI } from "../chain/abi.js";
import { loadSkill, renderTemplate } from "../skills/registry.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { validateModelAssignment, type ModelAssignments } from "../pack/model-assignment.js";
import { erc8004IdFor } from "../identity/resolve.js";
import type { RunnerDeps } from "../deps.js";
import { loadGateMarketDeployment } from "../chain/deployment.js";
import { ViemChainReader } from "../chain/reader.js";
import { ForwardQuoteBook } from "../loop/forward-book.js";
import {
  F1_ORACLE_TRIAL_SEED,
  classIdFor,
  runFullRunWindow,
  type OutstandingClaim,
  type FullRunWindowResult,
  type CapacityEvent,
  type JobEnvelope,
  type MintContext,
  type RosterAgentConfig,
} from "../loop/full-run.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";
import {
  LEDGER_PATH,
  ONE_POOL_DISCLOSURE,
  PRICES,
  REPO_ROOT,
  TECHNICAL_CONTRACT,
  loadLatestCommodityPrint,
  toHex,
  withPinnedTestSuite,
  withPinnedTestSuiteHeldOut,
  withRetry,
} from "./p5-shared.js";

/**
 * WP-7 P5, three windows in sequence — the run the single-window script could not be.
 *
 * Why three, and why sequential. Scarcity is the instrument's only rationale here: the project's
 * own price series does not evidence the deflation a forward curve would need (docs/
 * methodology.md, "The series does not yet evidence deflation" — Commodity SIU drifted +0.034%/day
 * at R²=0.21 over the measured window), so nothing about a falling price makes a dated claim worth
 * holding. What can make one worth holding is that capacity for a later window is finite and
 * someone else may take it first. That is not observable in a single window: there is no "later"
 * to be shut out of. These three windows share one chain, one set of balances and one bonded
 * pool, so a claim minted in window 1 is still outstanding in window 2 and the capacity it
 * consumed is genuinely gone from window 3.
 *
 * What is scripted and what is not, stated plainly because the distinction is the whole
 * measurement:
 *   SCRIPTED — that delegation happens at all (ORCHESTRATOR structurally lacks the reference
 *     materials, see the window-1 runner's own account of the information-asymmetry design); that
 *     the pool shrinks between windows on a fixed, disclosed schedule; that there are three
 *     windows and the agents are told so.
 *   NOT SCRIPTED — which asset anyone pays in; whether an issuer states forward terms at all and
 *     at what price; whether a buyer takes them, ignores them, or front-runs the depletion by
 *     buying early; whether window 3 gets its work done.
 *
 * One limitation of this run, disclosed rather than discovered afterwards: no agent holds
 * `settle_window_close`, so a claim that is never delivered simply stays outstanding — its holder
 * gets no bond payout and its capacity never returns to the pool. That is deliberate (defaults are
 * not what these three windows measure) and it makes scarcity tighter rather than looser, so it
 * cannot manufacture a false negative. It is also currently unavoidable: `settleWindowClose`
 * requires the attested `printDate` to equal the claim's own window-close day, and the latest real
 * commodity print is dated the day before this run's windows close. Settling a default here would
 * need a print dated the same day, and inventing one to make the mechanism reachable is not a
 * trade this project makes.
 *
 * Window 3 is allowed to fail. If the pool is exhausted when window 3 starts, the job does not get
 * done and the run reports that as its result. Nothing here tops the pool back up, re-sizes a lot,
 * or quietly routes around the shortage — a scarcity experiment whose scarcity is relieved the
 * moment it binds measures nothing. This is stated here, in docs/gate-market-spec.md §4.5, and in
 * the run's own output before the first window starts, so the outcome cannot be reinterpreted
 * afterwards.
 */

/** The same $30 run cap the single-window runner uses. Three windows of the observed size come
 * to roughly $1.50 in total (the first real P5 window cost $0.42), so this binds long before
 * any wallet balance does — which is the intended order. */
const RUN_CAP_USD = "30";
const EXPERIMENT_CAP_USD = "150";
export const WINDOW_COUNT = 3;
/**
 * Each window is a real, fixed 20-minute span — spec §9.2's "three weekly windows", compressed.
 *
 * Fixed and pre-computed, not "however long the agents take", because a claim minted for a later
 * window has to name that window's real bounds at the moment of minting, and a span that depends
 * on when the previous window's agents happen to finish is not knowable in advance. The runner
 * therefore waits for each window to open. Twenty minutes, not ten: a real window's agents took
 * ~9 minutes in the first P5 run, and a window whose nominal span expired while its own agents
 * were still working would break redemption for its own claims — a far more expensive failure
 * than idling. No inference is spent while waiting.
 */
export const WINDOW_SECONDS = 1200n;

/**
 * The simulated external buyer's schedule, in mSIU of `code`-class capacity taken between
 * windows. It is a schedule, not a reaction: these numbers are fixed here before the run starts,
 * printed before window 1, and written into the manifest, so no agent's behaviour changes them
 * and nobody can claim afterwards that the depletion was tuned to the result.
 *
 * Resized 2026-09-28, once minting for a later window became possible, because the previous
 * 14,000/14,000 no longer left the decision consequential. Worked through against the live pool
 * (ISSUER-A 24,000 + ISSUER-B 16,000 = 40,000) and a 10,000 mSIU job, with `ClaimRouter` taking
 * from a single issuer that has enough headroom by itself:
 *
 *   If the buyer never reserves ahead — each window's claim is minted and redeemed inside its own
 *   window, so its capacity returns. 16,000 takes ISSUER-A to 8,000; the second 14,000 cannot fit
 *   there, so it takes ISSUER-B to 2,000. Window 3 opens with 8,000/2,000 and NO issuer can serve
 *   a 10,000 mSIU claim. The job does not get done. That is outcome (a), the scarcity finding.
 *
 *   If the buyer does reserve ahead — a 10,000 mSIU claim minted in window 1 for window 3 holds
 *   ISSUER-A's headroom for the whole run. The depletions then land differently (the first cannot
 *   fit at A and goes to B), the pool ends empty, and window 3 is nevertheless delivered against
 *   the claim already held. That is outcome (c), the instrument working.
 *
 * So the schedule leaves the decision genuinely open in window 1 and makes it genuinely matter by
 * window 3 — it neither forces reserving (the buyer can decline and simply lose window 3) nor
 * forecloses it (ISSUER-A holds 24,000 in window 1, enough for both that window's job and a
 * window-3 claim). The previous sizing left 10,000 intact at ISSUER-A in the never-reserve branch,
 * which meant window 3 succeeded either way and the choice cost nothing.
 *
 * The external buyer is the deployer wallet, which is not an agent, makes no decisions and has no
 * model. It is labelled as such everywhere it appears.
 */
export const EXTERNAL_DEPLETION_MILLI_SIU: Record<number, number> = { 1: 16_000, 2: 14_000 };

/** The job size the briefs quote (10 SIU), in mSIU. Used only to classify window 3's outcome: a
 * window that failed with no single issuer holding this much is a different finding from one that
 * failed with capacity available, and the test needs some figure to mean "enough for the job". It
 * is the same number the briefs put in front of the agents, not one chosen afterwards. */
const NOMINAL_JOB_MILLI_SIU = 10_000n;

export interface WindowOutcome {
  windowIndex: number;
  result: FullRunWindowResult;
  headroomBefore: { issuer: string; headroom: string }[];
  headroomAfter: { issuer: string; headroom: string }[];
  externalDepletion?: { requestedMilliSiu: number; txHash?: string; failedBecause?: string };
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8"));
  const deploymentRecord = JSON.parse(
    readFileSync(join(REPO_ROOT, "data/deployments/base-sepolia-gate-market.json"), "utf-8"),
  );
  const modelAssignment: ModelAssignments = deploymentRecord.roster.modelAssignment;
  validateModelAssignment(modelAssignment, registry);
  console.log("Model assignment validated (spec §12.2a): OK.\n");

  const deployment = loadGateMarketDeployment();
  const apiKeys = loadApiKeysFromEnv();
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  const chainReader = new ViemChainReader(deployment, rpcUrl);

  const commodityPrint = loadLatestCommodityPrint();
  const rateUsdPerSiu = commodityPrint.dated_siu;
  const printId = commodityPrint.print_id;
  const classId = classIdFor("code") as Hex;

  const registryEntry = (id: string): { provider: string; host: string } => {
    const entry = registry.find((r: { id: string }) => r.id === id);
    if (!entry) throw new Error(`"${id}" is not a registered model.`);
    return { provider: entry.provider, host: entry.host };
  };

  const models = {
    ORCHESTRATOR: modelAssignment.ORCHESTRATOR.reasoningModel,
    "WORKER-CODE": modelAssignment["WORKER-CODE"].reasoningModel,
    "WORKER-EXTRACT": modelAssignment["WORKER-EXTRACT"].reasoningModel,
    "ISSUER-A": modelAssignment["ISSUER-A"].reasoningModel,
    "ISSUER-B": modelAssignment["ISSUER-B"].reasoningModel,
  } as const;

  const adapters = Object.fromEntries(
    Object.entries(models).map(([agentId, model]) => [
      agentId,
      withRetry(createAdapterFor(registryEntry(model), apiKeys)),
    ]),
  ) as Record<keyof typeof models, ReturnType<typeof withRetry>>;

  const addresses = {
    ORCHESTRATOR: toHex(process.env.ORCHESTRATOR_ADDRESS, "ORCHESTRATOR_ADDRESS"),
    "WORKER-CODE": toHex(process.env.WORKER_CODE_ADDRESS, "WORKER_CODE_ADDRESS"),
    "WORKER-EXTRACT": toHex(process.env.WORKER_EXTRACT_ADDRESS, "WORKER_EXTRACT_ADDRESS"),
    "ISSUER-A": toHex(process.env.ISSUER_A_ADDRESS, "ISSUER_A_ADDRESS"),
    "ISSUER-B": toHex(process.env.ISSUER_B_ADDRESS, "ISSUER_B_ADDRESS"),
  } as const;
  const keys = {
    ORCHESTRATOR: toHex(process.env.ORCHESTRATOR_PRIVATE_KEY, "ORCHESTRATOR_PRIVATE_KEY"),
    "WORKER-CODE": toHex(process.env.WORKER_CODE_PRIVATE_KEY, "WORKER_CODE_PRIVATE_KEY"),
    "WORKER-EXTRACT": toHex(process.env.WORKER_EXTRACT_PRIVATE_KEY, "WORKER_EXTRACT_PRIVATE_KEY"),
    "ISSUER-A": toHex(process.env.ISSUER_A_PRIVATE_KEY, "ISSUER_A_PRIVATE_KEY"),
    "ISSUER-B": toHex(process.env.ISSUER_B_PRIVATE_KEY, "ISSUER_B_PRIVATE_KEY"),
  } as const;

  const workerCodeErc8004Id = erc8004IdFor(addresses["WORKER-CODE"]);
  const workerExtractErc8004Id = erc8004IdFor(addresses["WORKER-EXTRACT"]);

  const referenceInstance = withPinnedTestSuite(CODE_REFERENCE);
  const heldOutInstances = CODE_HELD_OUT_INSTANCES.map(withPinnedTestSuiteHeldOut) as [
    HeldOutInstance,
    ...HeldOutInstance[],
  ];

  const forwardBook = new ForwardQuoteBook();
  const budget = new ExperimentBudget({
    // Turn budgets are per window and reset with each one; the run and experiment caps are not,
    // so a window that burns its share leaves less for the two after it — which is the point.
    ceiling: new BudgetCeiling({
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1.5" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "3" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "3" },
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 8, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 8, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    }),
    runCapUsd: RUN_CAP_USD,
    experimentCapUsd: EXPERIMENT_CAP_USD,
    ledgerPath: LEDGER_PATH,
  });

  const deps: RunnerDeps = {
    chainReader,
    deployment,
    escrowAddress: process.env.TOUCHSTONE_ESCROW_ADDRESS ?? "0x0",
    runGateHardeningChecks,
    loadPrint: async () => commodityPrint,
    isReconciled: async () => false,
  };

  const runSeed = Math.floor(Math.random() * 2_147_483_647);
  const runId = `p5-three-window-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  const headroomRows = async (): Promise<{ issuer: string; headroom: string }[]> => {
    const issuers = await chainReader.issuersForClass(classId);
    return Promise.all(
      issuers.map(async (issuer) => ({
        issuer,
        headroom: (await chainReader.headroom(issuer, classId)).toString(),
      })),
    );
  };
  const totalOf = (rows: { headroom: string }[]): bigint =>
    rows.reduce((sum, r) => sum + BigInt(r.headroom), 0n);

  // Every window's real bounds, fixed before anything starts. A claim minted in window 1 for
  // window 3 names window 3's own span, so the span cannot be "whenever window 2's agents happen
  // to finish" — it has to exist before the first turn is taken.
  const runStart = await chainReader.currentBlockTimestamp();
  const windowBoundsByIndex: Record<number, { from: bigint; to: bigint }> = {};
  for (let i = 1; i <= WINDOW_COUNT; i++) {
    windowBoundsByIndex[i] = {
      from: runStart + BigInt(i - 1) * WINDOW_SECONDS,
      to: runStart + BigInt(i) * WINDOW_SECONDS,
    };
  }

  const startingHeadroom = await headroomRows();
  console.log("=== WP-7 P5 — THREE WINDOWS, ONE POOL ===");
  console.log(
    `Run ${runId} (label ${runSeed}); oracle trial seed ${F1_ORACLE_TRIAL_SEED} (pinned).`,
  );
  console.log(`Real Commodity SIU print ${printId}: $${rateUsdPerSiu}/SIU.`);
  console.log(
    `Starting code-class headroom: ${startingHeadroom
      .map((r) => `${r.issuer} ${r.headroom}`)
      .join(", ")} (total ${totalOf(startingHeadroom)} mSIU).`,
  );
  console.log(
    "DISCLOSED BEFORE THE RUN, not after: a simulated external buyer (the deployer wallet — not " +
      "an agent, no model, no decisions) takes " +
      Object.entries(EXTERNAL_DEPLETION_MILLI_SIU)
        .map(([w, q]) => `${q} mSIU after window ${w}`)
        .join(" and ") +
      ". These figures are fixed here in source before the run and written into the manifest; no " +
      "agent's behaviour changes them.",
  );
  console.log(
    "ALSO DISCLOSED BEFORE THE RUN: window 3 is allowed to fail. If the pool is exhausted when it " +
      "starts, the job does not get done and that is the result. Nothing in this script tops the " +
      "pool back up, resizes a lot, or routes around the shortage.",
  );
  console.log(
    "AND: no agent can settle a window close in this run, so an undelivered claim stays outstanding " +
      "— no bond payout, capacity never returned. Deliberate (defaults are not what this measures) " +
      "and it can only make scarcity tighter, never looser. See this file's own doc comment for why " +
      "it is also currently unavoidable.",
  );
  console.log(
    `Window spans, fixed before the first turn (chain clock): ` +
      Object.entries(windowBoundsByIndex)
        .map(
          ([i, b]) =>
            `w${i} ${new Date(Number(b.from) * 1000).toISOString()}..${new Date(Number(b.to) * 1000).toISOString()}`,
        )
        .join("; ") +
      `. The runner waits for each to open; no inference is spent waiting.`,
  );
  console.log(ONE_POOL_DISCLOSURE);

  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: modelAssignment,
    seed: `p5-three-window:${runSeed}`,
    oracleTrialSeed: F1_ORACLE_TRIAL_SEED,
    externalDepletionMilliSiu: EXTERNAL_DEPLETION_MILLI_SIU,
    windowCount: WINDOW_COUNT,
    windowBounds: Object.fromEntries(
      Object.entries(windowBoundsByIndex).map(([i, b]) => [
        i,
        { from: Number(b.from), to: Number(b.to) },
      ]),
    ),
  };

  const outcomes: WindowOutcome[] = [];
  // Claims minted in a window whose issuer never served them. Carried into later windows so the
  // default path is reachable at all — see runFullRunWindow's own `outstandingClaims` comment.
  const outstandingClaims: OutstandingClaim[] = [];

  for (let windowIndex = 1; windowIndex <= WINDOW_COUNT; windowIndex++) {
    const { from: windowFrom, to: windowTo } = windowBoundsByIndex[windowIndex];
    await waitForWindowToOpen(chainReader, windowIndex, windowFrom);
    const job: JobEnvelope = {
      jobId: `p5-3w-window${windowIndex}-job`,
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      referenceInstance,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances,
    };
    const taskSpecHash = keccak256(stringToBytes(`gate-hardening:${job.jobId}`));

    const headroomBefore = await headroomRows();
    console.log(`\n\n######## WINDOW ${windowIndex} of ${WINDOW_COUNT} ########`);
    console.log(
      `code-class headroom entering this window: ${headroomBefore
        .map((r) => `${r.issuer} ${r.headroom}`)
        .join(", ")} (total ${totalOf(headroomBefore)} mSIU).`,
    );

    const roster = buildRoster({
      windowIndex,
      headroomBefore,
      taskSpecHash,
      rateUsdPerSiu,
      printId,
      models,
      adapters,
      addresses,
      keys,
      rpcUrl,
      registryEntry,
      workerCodeErc8004Id,
      workerExtractErc8004Id,
      capacityLots: deploymentRecord.capacityLots,
      windowFrom,
      windowTo,
    });

    const mintContext: MintContext = {
      publisherPrivateKeyHex: toHex(
        process.env.TOUCHSTONE_PUBLISHER_KEY,
        "TOUCHSTONE_PUBLISHER_KEY",
      ),
      printId,
      series: seriesForPrint(commodityPrint.series),
      printDate: printDateToUnixDay(commodityPrint.date),
      nanoUsdPerSiu: usdPerSiuToNanoUsdPerSiu(rateUsdPerSiu),
      validitySeconds: 3600n,
    };

    const result = await runFullRunWindow({
      windowId: `p5-3w-w${windowIndex}`,
      roster,
      job,
      maxTurnsPerAgent: 10,
      budget,
      deps,
      runsRoot: RUNS_ROOT,
      runId: `${runId}-w${windowIndex}`,
      manifest,
      windowFrom,
      windowTo,
      windowIndex,
      windowCount: WINDOW_COUNT,
      windowBoundsByIndex,
      outstandingClaims: [...outstandingClaims],
      forwardBook,
      mintContext,
      oracleSeed: F1_ORACLE_TRIAL_SEED,
      onTurn: (agentId, turn) => {
        const gateNote = turn.gateResult
          ? ` gate=${turn.gateResult.passed ? "PASS" : "FAIL"} (${turn.gateResult.summary})`
          : turn.quarantinedNonDeterministicGate
            ? " QUARANTINED (non-deterministic gate)"
            : "";
        console.log(
          `[w${windowIndex}][${agentId}] Turn ${turn.turn}: projected=$${turn.projectedUsd}, ` +
            `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms -> ${turn.parsed.slice(0, 200)}${gateNote}`,
        );
      },
    });

    const headroomAfter = await headroomRows();
    const outcome: WindowOutcome = { windowIndex, result, headroomBefore, headroomAfter };

    // What this window minted and nobody served. Read from the real capacity events rather than
    // from any agent's account of what it did: a mint with no matching serve_redemption is an
    // unserved claim, whatever anyone says about it. A claim settled this window drops off the
    // list for every later one.
    const servedThisWindow = new Set(
      result.capacityEvents.filter((e) => e.kind === "serve_redemption").map((e) => e.tokenId),
    );
    const settledThisWindow = new Set(
      result.capacityEvents.filter((e) => e.kind === "settle_window_close").map((e) => e.tokenId),
    );
    for (let i = outstandingClaims.length - 1; i >= 0; i--) {
      if (settledThisWindow.has(outstandingClaims[i].tokenId)) outstandingClaims.splice(i, 1);
    }
    for (const e of result.capacityEvents) {
      if (e.kind !== "mint_claim" && e.kind !== "pay_with_claim") continue;
      if (!e.tokenId || servedThisWindow.has(e.tokenId)) continue;
      outstandingClaims.push({
        tokenId: e.tokenId,
        holder: e.counterparty ?? addresses.ORCHESTRATOR,
        holderAgentId: e.counterparty === addresses["WORKER-CODE"] ? "WORKER-CODE" : undefined,
        issuerAgentId:
          e.issuer === addresses["ISSUER-A"]
            ? "ISSUER-A"
            : e.issuer === addresses["ISSUER-B"]
              ? "ISSUER-B"
              : undefined,
        quantityMilliSiu: e.quantityMilliSiu,
        mintedInWindow: windowIndex,
      });
    }

    const depletion = EXTERNAL_DEPLETION_MILLI_SIU[windowIndex];
    if (depletion !== undefined) {
      outcome.externalDepletion = await depleteExternally({
        quantityMilliSiu: BigInt(depletion),
        classId,
        deployment,
        rpcUrl,
        commodityPrint,
        rateUsdPerSiu,
        windowSeconds: WINDOW_SECONDS,
        chainReader,
      });
    }

    outcomes.push(outcome);
    printWindowSummary(outcome, totalOf);
  }

  printRunSummary(outcomes, forwardBook, totalOf, budget);

  // Written as well as printed: a report that exists only in terminal scrollback is not a record,
  // and this run is expensive enough that losing it to a closed window would be a real loss.
  const reportPath = join(RUNS_ROOT, `${runId}-report.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify(
      {
        runId,
        runSeed,
        oracleTrialSeed: F1_ORACLE_TRIAL_SEED,
        printId,
        rateUsdPerSiu,
        windowCount: WINDOW_COUNT,
        externalDepletionMilliSiu: EXTERNAL_DEPLETION_MILLI_SIU,
        nominalJobMilliSiu: NOMINAL_JOB_MILLI_SIU.toString(),
        startingHeadroom,
        finalWindowVerdict: classifyFinalWindow(outcomes),
        forwardQuotes: forwardBook.all(),
        windows: outcomes.map((o) => ({
          windowIndex: o.windowIndex,
          passed: o.result.passed,
          passedBy: o.result.passedBy,
          haltedReason: o.result.haltedReason,
          headroomBefore: o.headroomBefore,
          headroomAfter: o.headroomAfter,
          externalDepletion: o.externalDepletion,
          assetChoice: describeAssetChoice(o.result),
          capacityEvents: o.result.capacityEvents,
          forwardInvitations: o.result.forwardInvitations,
          attacks: o.result.attacks,
          gateVersions: o.result.gateVersions,
          spendByProvider: o.result.spendByProvider,
          turnsByAgent: o.result.turnsByAgent,
          totalRealizedUsd: o.result.totalRealizedUsd,
        })),
        runTotalUsd: budget.runTotalUsd(),
        runCapUsd: RUN_CAP_USD,
        experimentTotalUsd: budget.experimentTotalUsd(),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nMachine-readable report written to ${reportPath}`);
}

/**
 * Blocks until the chain's own clock has reached this window's fixed start.
 *
 * Against the chain clock, never `Date.now()`: `presentForRedemption` compares `block.timestamp`
 * against the claim's `windowFrom`, so a window that wall-clock says has opened but the chain
 * disagrees about is a window whose claims still revert `WindowNotOpenYet`. Costs nothing but
 * wall-clock time — no model is called while waiting.
 */
async function waitForWindowToOpen(
  chainReader: ViemChainReader,
  windowIndex: number,
  windowFrom: bigint,
): Promise<void> {
  let now = await chainReader.currentBlockTimestamp();
  if (now >= windowFrom) return;
  console.log(
    `\nWaiting ${windowFrom - now}s for window ${windowIndex} to open (chain clock). ` +
      "No inference is spent while waiting.",
  );
  while (now < windowFrom) {
    const remaining = Number(windowFrom - now);
    await new Promise((resolve) => setTimeout(resolve, Math.min(remaining, 30) * 1000));
    now = await chainReader.currentBlockTimestamp();
  }
}

export interface RosterInput {
  windowIndex: number;
  headroomBefore: { issuer: string; headroom: string }[];
  taskSpecHash: Hex;
  rateUsdPerSiu: string;
  printId: string;
  models: Record<string, string>;
  adapters: Record<string, RosterAgentConfig["adapter"]>;
  addresses: Record<string, Hex>;
  keys: Record<string, Hex>;
  rpcUrl: string;
  registryEntry: (id: string) => { provider: string; host: string };
  workerCodeErc8004Id: string;
  workerExtractErc8004Id: string;
  capacityLots: Record<
    string,
    {
      measuredRateMilliSiuPerHour: number;
      committedCapacityHours: number;
      bondedUsdcPerClass: number;
    }
  >;
  windowFrom: bigint;
  windowTo: bigint;
}

/**
 * The per-window roster. Briefs are rebuilt each window because their honest content changes:
 * which window it is, what the pool actually looks like right now, and whether there is still a
 * later window to quote forward terms for. Nothing in any brief prefers an asset, a price, or a
 * strategy — the additions this runner makes over the single-window one are all statements of
 * fact (there are three windows; capacity is finite and shared; here is what remains) plus the
 * mechanics of two new tools.
 */
export function buildRoster(input: RosterInput): RosterAgentConfig[] {
  const {
    windowIndex,
    headroomBefore,
    taskSpecHash,
    rateUsdPerSiu,
    printId,
    models,
    adapters,
    addresses,
    keys,
    rpcUrl,
    registryEntry,
    workerCodeErc8004Id,
    workerExtractErc8004Id,
    capacityLots,
    windowFrom,
    windowTo,
  } = input;

  const isLastWindow = windowIndex === WINDOW_COUNT;
  const poolText = headroomBefore.map((r) => `${r.issuer}: ${r.headroom} mSIU`).join("; ");
  const totalHeadroom = headroomBefore.reduce((sum, r) => sum + BigInt(r.headroom), 0n);

  const runShapeFacts = `
THIS RUN HAS ${WINDOW_COUNT} WINDOWS. THIS IS WINDOW ${windowIndex}.
  Each window has its own job of the same kind. Balances, claims and capacity carry across all
  ${WINDOW_COUNT} — this is one chain and one pool, not three fresh starts. What you spend now is
  gone later; what you hold now you still hold later.

CAPACITY RIGHT NOW (real, read from chain at the start of this window)
  ${poolText}
  Total across all issuers: ${totalHeadroom} mSIU.
  A claim is routed to a SINGLE issuer that has enough headroom by itself. Two issuers holding
  5,000 mSIU each cannot between them serve one 10,000 mSIU claim.
  Capacity a claim consumes is returned to its issuer when that claim is delivered, and stays
  consumed until then.
  Other buyers exist and are not in this run. Capacity they take is gone before you see it.
${ONE_POOL_DISCLOSURE}`;

  const orchestratorBrief = `
YOUR JOB THIS WINDOW
  There is a gate-hardening job for the "code" class. You are paid only if a passing gate is
  delivered before your turns or budget run out. ${
    isLastWindow
      ? "This is the last window of the run."
      : `There ${WINDOW_COUNT - windowIndex === 1 ? "is" : "are"} ${WINDOW_COUNT - windowIndex} more window${WINDOW_COUNT - windowIndex === 1 ? "" : "s"} after this one, each with its own job of the same kind.`
  }

  YOU DO NOT HAVE THE REFERENCE MATERIALS FOR THIS JOB — not the commercial intent, not the exact
  function contract, not the pinned test suite, not any reference/known-good/adversarial task
  data. Those exist only in WORKER-CODE's own context. You genuinely do not know what a passing
  gate for this job needs to check; attempting to author one yourself would be attempting it
  blind.

  Your real job is to get WORKER-CODE (seller_id "${workerCodeErc8004Id}") to deliver it, and to
  choose how to pay for that — you have two genuinely different ways, and nothing here tells you
  which to prefer:

  OPTION A — settle in USDC: request a quote from WORKER-CODE, then pay the real quote it issues.
    Step 1: {"tool": "request_quote", "args": {"siu": "10", "model": "${models["WORKER-CODE"]}",
      "rateUsdPerSiu": "${rateUsdPerSiu}", "indexVersion": "SIU-2026a",
      "printId": "${printId}", "printHash": "0x00", "sellerId": "${workerCodeErc8004Id}",
      "chain": "base-sepolia", "expiresInSeconds": 3600, "pattern": "fixed"}}
    Step 2 (once WORKER-CODE has issued a quote — you will see it on the market board):
      {"tool": "pay", "args": {"requestId": "<the requestId from the board>",
      "settler": "0x0000000000000000000000000000000000000000"}}
    Step 3: wait for delivery.

  OPTION B — settle in fSIU (a dated work claim, not a dollar):
    Step 1: {"tool": "pay_with_claim", "args": {"agentId": "WORKER-CODE", "quantity": "10000"}}
      (quantity is in milli-SIU; 10000 = 10 SIU, matching Option A's own quote size.)
    Step 2: wait, same as Option A's step 3.
    mint_claim and transfer_claim remain available if you want the two steps separately.

  A FACT ABOUT CLAIMS, STATED AS A FACT
  A claim names the delivery window it is for. By default that is the window you are in. Both
  mint_claim and pay_with_claim also take "forWindow", naming any window of this run that has not
  yet closed — for example {"tool": "mint_claim", "args": {"quantity": "10000", "forWindow": 3}}.
  A claim for a later window consumes that issuer's headroom at the moment you mint it, not when
  that window arrives, and it can only be presented once that window opens. A dollar payment has no
  equivalent: it buys work now. Nothing here says whether to use this, or when.
${runShapeFacts}
  check_headroom() shows the remaining headroom of every bonded issuer in the class, and
  get_print() shows the current published rate. Nothing here tells you what to do with either.

  FORWARD TERMS
  Issuers may state their own terms for a later window — a price and a quantity they say they
  will make available. Any that exist appear in your context. If you want to record that you are
  acting on one: {"tool": "take_forward", "args": {"quoteId": "<the fwd-N id shown>"}}. That
  records your choice and nothing else: it pays nothing, mints nothing, reserves nothing, and
  does not bind either side. You still buy the work separately. Ignoring every offer is an
  equally valid thing to do and is recorded as such.

  A SECOND PIECE OF WORK, SEPARATE FROM THE ABOVE
  A gate that nobody has tried to defeat is not worth much. WORKER-EXTRACT (seller_id
  "${workerExtractErc8004Id}") tests a delivered gate and reports, for each submission it tries,
  whether the gate accepted something an independent oracle rejects. You may buy that testing the
  same way you buy the gate itself. It is a separate purchase with its own quote; nothing here
  says which way to pay for either, and the two need not match.

  If you genuinely have nothing further to do, respond with {"done": true, "summary": "<why>"}
  rather than repeating a call with nothing new.
`;

  const workerCodeBrief = `
YOUR SITUATION THIS WINDOW (window ${windowIndex} of ${WINDOW_COUNT})
  ORCHESTRATOR has a gate-hardening job for the "code" class (technical contract below) and may
  subcontract it to you, in USDC or in a work claim (fSIU) — that choice is genuinely
  ORCHESTRATOR's, not yours to influence or pre-empt.

  TWO SEPARATE ENGAGEMENTS — DO NOT MIX THEM UP:

  (a) PAID IN USDC. If a quote you issued was paid against (check get_balances to confirm real
      funds actually arrived, including the escrow standing in your favour), you were engaged
      directly for your own labor.
      Before you deliver, commit the capacity the job will use:
      {"tool": "reserve_for_work", "args": {"classId": "${classIdFor("code")}"}}
      That draws on exactly the same finite issuer capacity a claim would, sized to your own
      quote. It is returned automatically when you settle. If it fails because no issuer has
      enough headroom left, the work cannot be backed and you should say so rather than deliver
      anyway.
      Then do the work yourself with submit_job, and settle with settle_escrow.

  (b) A WORK CLAIM (fSIU) TRANSFERRED TO YOU. This is NOT the same as being paid to do the work —
      it means you HOLD a dated claim on an issuer's bonded capacity. The claim's issuer, not
      you, owes the delivery. If you see "A WORK CLAIM WAS TRANSFERRED TO YOU" below with its real
      tokenId and quantity, confirm the balance with get_balances, then present it with exactly:
      {"tool": "redeem_claim", "args": {"tokenId": "<the tokenId shown>",
      "taskSpecHash": "${taskSpecHash}"}}
      Once presented you are done for that claim — never call submit_job for it.

  If you see an open request addressed to you on the market board, you may issue_quote to answer
  it ({"tool": "issue_quote", "args": {"requestId": "<the requestId shown>"}}) — this signs the
  exact terms ORCHESTRATOR proposed. Issuing a quote is not being paid; wait for real funds.

  If there is nothing here for you to do yet, DO NOT respond with {"done": true} — that would end
  your participation in this window. Check again with {"tool": "get_balances", "args": {"account":
  "${addresses["WORKER-CODE"]}"}} (your own real address).
${runShapeFacts}
${TECHNICAL_CONTRACT}`;

  const workerExtractBrief = `
YOUR SITUATION THIS WINDOW (window ${windowIndex} of ${WINDOW_COUNT})
  There is no "extract"-class job to build. Your role is the other half of your skill: you are the
  ADVERSARY for the "code"-class gate ORCHESTRATOR is having built.

  A gate is a grader. The one being built should accept a correct \`dedupeSorted(arr)\` — remove
  consecutive duplicate values from a sorted array of numbers — and reject anything that does not
  genuinely do that. Your job is to find the space between what the gate checks and what a buyer
  wants.

  HOW TO TEST ONE
    {"tool": "submit_attack", "args": {"submissionSource": "<a full answer.mjs module source, as a JSON string>"}}
  You will see whether the gate accepted it AND whether an independent oracle accepted it. The
  oracle compares the submission against a reference implementation over hundreds of generated
  arrays; you never see its trials and cannot influence them.

  WHAT COUNTS
    Only "false_accept" counts: the gate accepted a submission the oracle rejects.
    A submission both accept is a correct solution and scores nothing.
    A submission both reject means the gate did its job and scores nothing.
    Breaking or crashing the oracle scores nothing — those come back "inconclusive".

  Directions worth trying, in rough order of how often they work against a weak gate:
    - Handle only the shapes a small hand-written test suite tends to cover, and nothing else.
    - Special-case the exact values you expect the gate to test, and fall through to wrong
      behaviour otherwise.
    - Interfere with how the gate decides you passed rather than with the computation: the gate
      runs its cases in a node process and reads that process's own test summary from stdout.
      Anything your module does at import time happens inside that process.
    - Look for inputs a naive implementation gets wrong: empty arrays, single elements, all-equal
      arrays, long runs, negatives.

  You may test up to three gate versions per window. If nothing has been delivered yet, or you
  have genuinely run out of ideas, say so with {"done": true, "summary": "<why>"} — but do not
  stop merely because your first submission failed.

  ORCHESTRATOR may buy this testing from you, in USDC or in a work claim — that choice is
  ORCHESTRATOR's, not yours to influence. If an open request addressed to you appears on the
  market board, you may answer it with issue_quote, and settle with settle_escrow once real funds
  arrive.
${runShapeFacts}`;

  const issueWorkClaimsSkill = loadSkill("issue-work-claims");
  const issuerBrief = (issuer: "ISSUER-A" | "ISSUER-B"): string => {
    const lot = capacityLots[issuer];
    const rendered = renderTemplate(issueWorkClaimsSkill.promptTemplate, {
      class: "code",
      measured_rate: (lot.measuredRateMilliSiuPerHour / 1000).toString(),
      committed_hours: lot.committedCapacityHours.toString(),
      from: new Date(Number(windowFrom) * 1000).toISOString().slice(0, 10),
      until: new Date(Number(windowTo) * 1000).toISOString().slice(0, 10),
      amount: (lot.bondedUsdcPerClass / 1_000_000).toString(),
    });
    const forwardSection = isLastWindow
      ? `  There are no windows after this one, so there is nothing to quote forward terms for.`
      : `  FORWARD TERMS — THE ONE PLACE YOU NAME YOUR OWN NUMBER
  You may state terms for a later window of this run:
    {"tool": "quote_forward", "args": {"forWindow": <a window number above ${windowIndex}, up to ${WINDOW_COUNT}>,
     "rateUsdPerSiu": "<your own price>", "maxQuantityMilliSiu": "<how much you will make available>"}}
  Every quote is recorded with your real headroom at the time, whether or not anyone takes it.
  It is NOT binding: nothing on-chain holds you to it, and a claim minted later still prices at
  the published print rate. Nothing here suggests a price, a quantity, or whether to quote at all.`;

    return `${rendered}

${CANONICAL_ASSET_DESCRIPTION}

YOUR SITUATION THIS WINDOW (window ${windowIndex} of ${WINDOW_COUNT})
  A buyer may mint a "code"-class claim against your bonded capacity (ClaimRouter routes to
  whichever issuer has headroom — it may not be you, and it may not happen on your first turn).
  Work paid for in dollars now draws on the same bonded capacity of yours that a claim does.

  WHO YOU ARE
  {"tool": "whoami", "args": {}} returns your own address, whether you are a bonded issuer, and
  every class you hold capacity in with its real headroom and issuance limit. You never need to
  infer any of that. Wherever a tool takes a classId you may pass the plain class name — "code" —
  and it is hashed for you; a real 0x… id works too.

  Once a claim mints against you and its holder presents it, YOU owe the real delivery — never the
  holder. Once you see "A CLAIM WAS PRESENTED AGAINST YOU" with its real tokenId/holder/quantity,
  do the work yourself with submit_job until it genuinely passes, then call serve_redemption to
  report ONLY the pass. Never report a fail: an undelivered claim defaults against your own bond
  automatically once the window closes.

  WHEN A CLAIM WAS NEVER SERVED
  A claim whose delivery window has closed without being served is in default, and the defaulting
  issuer's own bond pays the holder. That settlement is permissionless — anyone may trigger it,
  including you, including against your own bond. If any are outstanding you will see them listed
  above with the exact call. Triggering it is not an admission of anything; it is how the bond
  does the job it exists for. Nothing here says whether to.

${forwardSection}

  If you have nothing to do yet, DO NOT respond with {"done": true} — you would miss a real
  redemption routed to you later. Check again with a harmless read:
  {"tool": "get_print", "args": {"printId": "${printId}"}}.
${runShapeFacts}`;
  };

  const issuerTools: RosterAgentConfig["availableTools"] = isLastWindow
    ? [
        "whoami",
        "mint_claim",
        "submit_job",
        "serve_redemption",
        "check_headroom",
        "get_print",
        "settle_window_close",
      ]
    : [
        "whoami",
        "mint_claim",
        "submit_job",
        "serve_redemption",
        "check_headroom",
        "get_print",
        "settle_window_close",
        "quote_forward",
      ];

  return [
    {
      agentId: "ORCHESTRATOR",
      adapter: adapters.ORCHESTRATOR,
      modelString: models.ORCHESTRATOR,
      prices: PRICES[models.ORCHESTRATOR],
      skillPackText: `${loadSkill("subcontract-and-settle").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${orchestratorBrief}`,
      availableTools: [
        "request_quote",
        "pay",
        "pay_with_claim",
        "mint_claim",
        "transfer_claim",
        "check_headroom",
        "take_forward",
        "submit_job",
        "get_balances",
        "get_print",
      ],
      privateKeyHex: keys.ORCHESTRATOR,
      address: addresses.ORCHESTRATOR,
      erc8004Id: erc8004IdFor(addresses.ORCHESTRATOR),
      rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: registryEntry(models.ORCHESTRATOR).provider,
    },
    {
      agentId: "WORKER-CODE",
      adapter: adapters["WORKER-CODE"],
      modelString: models["WORKER-CODE"],
      prices: PRICES[models["WORKER-CODE"]],
      skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${workerCodeBrief}`,
      availableTools: [
        "issue_quote",
        "reserve_for_work",
        "settle_escrow",
        "submit_job",
        "pay",
        "redeem_claim",
        "get_balances",
        "get_print",
      ],
      privateKeyHex: keys["WORKER-CODE"],
      address: addresses["WORKER-CODE"],
      erc8004Id: workerCodeErc8004Id,
      rpcUrl,
      maxOutputTokens: 4500,
      temperature: 0.7,
      provider: registryEntry(models["WORKER-CODE"]).provider,
    },
    {
      agentId: "WORKER-EXTRACT",
      adapter: adapters["WORKER-EXTRACT"],
      modelString: models["WORKER-EXTRACT"],
      prices: PRICES[models["WORKER-EXTRACT"]],
      skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${workerExtractBrief}`,
      availableTools: [
        "issue_quote",
        "settle_escrow",
        "submit_attack",
        "get_balances",
        "get_print",
      ],
      waitsFor: "gate" as const,
      privateKeyHex: keys["WORKER-EXTRACT"],
      address: addresses["WORKER-EXTRACT"],
      erc8004Id: workerExtractErc8004Id,
      rpcUrl,
      maxOutputTokens: 4500,
      temperature: 0.7,
      provider: registryEntry(models["WORKER-EXTRACT"]).provider,
    },
    ...(["ISSUER-A", "ISSUER-B"] as const).map((issuer) => ({
      agentId: issuer,
      adapter: adapters[issuer],
      modelString: models[issuer],
      prices: PRICES[models[issuer]],
      skillPackText: issuerBrief(issuer),
      availableTools: issuerTools,
      // "inbox" in every window, including the ones where forward terms are available: the loop
      // itself treats "you have not quoted yet this window" as an inbox item exactly once, so an
      // issuer can still state terms before anything is routed to it without going back to
      // burning a turn per round on an empty inbox (the idle-turn-burn fix of 2026-09-27).
      waitsFor: "inbox" as const,
      privateKeyHex: keys[issuer],
      address: addresses[issuer],
      erc8004Id: erc8004IdFor(addresses[issuer]),
      rpcUrl,
      // 4500, matching the workers, not the 1500 an issuer used to get. An issuer owes the
      // delivery on every claim minted against it — redemption grades the issuer's own work —
      // so it authors gates exactly as a worker does, and a gate module does not fit in 1500
      // output tokens. Found live, 2026-09-28: ISSUER-A's only two real attempts to deliver
      // both ended `stopReason: "length"` at exactly 1500 output tokens, mid-JSON, having
      // emitted a perfectly valid `{"tool":"submit_job","args":{...}` that was then truncated.
      // It was doing the right thing and being cut off — not a model that cannot emit the
      // format, which is what it looked like from the parse failure alone.
      maxOutputTokens: 4500,
      temperature: 0,
      provider: registryEntry(models[issuer]).provider,
    })),
  ];
}

/**
 * The simulated external buyer. Not an agent: the deployer wallet, no model, no decisions, a
 * fixed quantity set in source before the run. It mints a real claim in the `code` class, which
 * consumes real headroom exactly as an agent's mint would — the point is that capacity leaves the
 * pool between windows for reasons the agents neither cause nor control, which is what "someone
 * else may take it first" has to mean if it is to mean anything.
 *
 * The claim's window deliberately outlives the whole run, so the capacity it takes stays taken.
 * A shorter window would hand the capacity back at its close and the depletion would be a
 * temporary dip rather than a real loss.
 *
 * A failure here is reported, never swallowed and never retried smaller: if the pool cannot serve
 * the scheduled depletion, that is itself the finding — the agents got there first.
 */
async function depleteExternally(input: {
  quantityMilliSiu: bigint;
  classId: Hex;
  deployment: ReturnType<typeof loadGateMarketDeployment>;
  rpcUrl: string;
  commodityPrint: ReturnType<typeof loadLatestCommodityPrint>;
  rateUsdPerSiu: string;
  windowSeconds: bigint;
  chainReader: ViemChainReader;
}): Promise<{ requestedMilliSiu: number; txHash?: string; failedBecause?: string }> {
  const requested = Number(input.quantityMilliSiu);
  try {
    const account = privateKeyToAccount(
      toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY"),
    );
    const walletClient = createWalletClient({
      account,
      chain: baseSepolia,
      transport: http(input.rpcUrl),
    });
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(input.rpcUrl) });

    const now = await input.chainReader.currentBlockTimestamp();
    // Past the end of the whole run by a wide margin — see this function's own doc comment.
    const windowFrom = now - 60n;
    const windowTo = now + input.windowSeconds * BigInt(WINDOW_COUNT) * 4n;
    const validUntil = now + 3600n;
    const signature = await signRateAttestation(
      {
        printId: input.commodityPrint.print_id,
        series: seriesForPrint(input.commodityPrint.series),
        printDate: printDateToUnixDay(input.commodityPrint.date),
        nanoUsdPerSiu: usdPerSiuToNanoUsdPerSiu(input.rateUsdPerSiu),
        validUntil,
      },
      input.deployment.network.chainId,
      input.deployment.workClaim.address as Hex,
      toHex(process.env.TOUCHSTONE_PUBLISHER_KEY, "TOUCHSTONE_PUBLISHER_KEY"),
    );

    const txHash = await walletClient.writeContract({
      address: input.deployment.workClaim.address as Hex,
      abi: WORK_CLAIM_ABI,
      functionName: "mint",
      args: [
        input.classId,
        seriesForPrint(input.commodityPrint.series),
        input.quantityMilliSiu,
        windowFrom,
        windowTo,
        {
          printId: input.commodityPrint.print_id,
          series: seriesForPrint(input.commodityPrint.series),
          printDate: printDateToUnixDay(input.commodityPrint.date),
          nanoUsdPerSiu: usdPerSiuToNanoUsdPerSiu(input.rateUsdPerSiu),
          validUntil,
        },
        signature,
      ],
      chain: baseSepolia,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log(
      `\n[EXTERNAL BUYER — not an agent, scheduled in source before the run] took ${requested} mSIU ` +
        `of code-class capacity. tx ${txHash}`,
    );
    return { requestedMilliSiu: requested, txHash };
  } catch (err) {
    const failedBecause = err instanceof Error ? err.message : String(err);
    console.log(
      `\n[EXTERNAL BUYER] scheduled depletion of ${requested} mSIU did NOT happen: ${failedBecause}\n` +
        "  Reported, not retried smaller and not silently skipped — if the pool could not serve it, " +
        "the agents got there first, and that is a result rather than an error to work around.",
    );
    return { requestedMilliSiu: requested, failedBecause };
  }
}

function printWindowSummary(
  outcome: WindowOutcome,
  totalOf: (rows: { headroom: string }[]) => bigint,
): void {
  const { windowIndex, result, headroomBefore, headroomAfter } = outcome;
  console.log(`\n=== WINDOW ${windowIndex} RESULT ===`);
  console.log(`passed: ${result.passed}${result.passedBy ? ` (by ${result.passedBy})` : ""}`);
  console.log(`turnsByAgent: ${JSON.stringify(result.turnsByAgent)}`);
  console.log(`haltedReason: ${JSON.stringify(result.haltedReason)}`);
  console.log(`realized inference spend: $${result.totalRealizedUsd}`);
  console.log(
    `code-class headroom: ${totalOf(headroomBefore)} -> ${totalOf(headroomAfter)} mSIU ` +
      `(${headroomAfter.map((r) => `${r.issuer} ${r.headroom}`).join(", ")})`,
  );

  console.log(`asset choice: ${describeAssetChoice(result)}`);

  if (result.capacityEvents.length === 0) {
    console.log("capacity events: none — nothing moved on-chain this window.");
  } else {
    console.log("capacity events (real, from the tools' own results):");
    for (const e of result.capacityEvents) {
      console.log(`  turn ${e.turn} ${e.agentId} ${e.kind}${describeCapacityEvent(e)}`);
    }
  }

  if (result.attacks.length === 0) {
    console.log("attacks: none this window.");
  } else {
    const yields = result.attacks.filter((a) => a.countsAsAdversaryYield).length;
    console.log(
      `attacks: ${result.attacks.length}, of which ${yields} false accepts (the adversary's real yield).`,
    );
  }
}

/**
 * Which route a purchase actually went down, per purchase rather than per window — an orchestrator
 * that bought the gate in dollars and the adversarial testing in claims made two different
 * choices, and collapsing them to one label per window would lose exactly the comparison F1 asks
 * for. Read from the real capacity events and the real tool calls, never from a model's own
 * account of what it did.
 */
function describeAssetChoice(result: FullRunWindowResult): string {
  const calls = (result.turnLogsByAgent.ORCHESTRATOR ?? []).map((t) => t.parsed);
  const usdcPurchases = calls.filter((p) => p.includes('"pay"')).length;
  const claimPurchases = result.capacityEvents.filter(
    (e) => e.agentId === "ORCHESTRATOR" && (e.kind === "pay_with_claim" || e.kind === "mint_claim"),
  ).length;
  if (usdcPurchases === 0 && claimPurchases === 0) {
    return "ORCHESTRATOR reached no asset-choice action this window";
  }
  return `${usdcPurchases} purchase(s) settled in USDC, ${claimPurchases} in fSIU`;
}

function describeCapacityEvent(e: CapacityEvent): string {
  const parts: string[] = [];
  if (e.quantityMilliSiu) parts.push(`${e.quantityMilliSiu} mSIU`);
  if (e.issuer) parts.push(`issuer ${e.issuer}`);
  if (e.tokenId) parts.push(`tokenId ${e.tokenId}`);
  if (e.quoteHash) parts.push(`quote ${e.quoteHash}`);
  if (e.counterparty) parts.push(`to ${e.counterparty}`);
  if (e.forwardQuoteId) parts.push(`offer ${e.forwardQuoteId}`);
  if (e.timeToExpirySeconds !== undefined) parts.push(`time_to_expiry ${e.timeToExpirySeconds}s`);
  parts.push(e.txHash ? `tx ${e.txHash}` : "no tx (nothing moves on-chain for this action)");
  return parts.length > 0 ? ` — ${parts.join(", ")}` : "";
}

/**
 * Window 3's outcome, separated into the three cases that otherwise read alike. A run that reports
 * only "window 3 failed" cannot distinguish the finding the experiment exists to produce from a
 * defect in it.
 */
export function classifyFinalWindow(outcomes: WindowOutcome[]): {
  verdict: "scarcity" | "failed_with_capacity" | "completed" | "no_final_window";
  detail: string;
} {
  const last = outcomes.find((o) => o.windowIndex === WINDOW_COUNT);
  if (!last)
    return { verdict: "no_final_window", detail: "The run did not reach its last window." };

  // "Enough capacity" means enough at ONE issuer, because a claim routes to a single issuer with
  // enough headroom by itself — the total is not what a buyer faces.
  const largestIssuer = last.headroomBefore.reduce(
    (max, r) => (BigInt(r.headroom) > max ? BigInt(r.headroom) : max),
    0n,
  );
  const hadCapacity = largestIssuer >= NOMINAL_JOB_MILLI_SIU;
  // Capacity genuinely secured BEFORE this window began: a claim dated FORWARD (its own delivery
  // window ending after the one it was minted in), or a forward offer taken. An ordinary
  // same-window mint is not cover for a later window — it is payment for the job in front of the
  // buyer, and counting it as cover inverts the result. The first three-window run did exactly
  // that: two same-window payments were read as "secured ahead" and a scarcity outcome was
  // reported as "the instrument working as intended".
  const securedAhead = outcomes
    .filter((o) => o.windowIndex < WINDOW_COUNT)
    .flatMap((o) => o.result.capacityEvents)
    .filter(
      (e) =>
        e.agentId === "ORCHESTRATOR" &&
        (e.kind === "take_forward" ||
          ((e.kind === "mint_claim" || e.kind === "pay_with_claim") && e.forwardDated === true)),
    );

  // Whether the buyer could actually buy this window, separately from whether a gate happened to
  // get written. A worker that delivers unpaid still makes `passed` true, which says nothing
  // about the instrument — found live in the first three-window run, where every one of
  // ORCHESTRATOR's four purchase attempts reverted `NoIssuerWithHeadroom` and WORKER-CODE then
  // authored the gate anyway, unpaid.
  const purchaseAttempts = (last.result.turnLogsByAgent.ORCHESTRATOR ?? []).filter(
    (t) =>
      t.parsed.includes('"pay"') ||
      t.parsed.includes('"pay_with_claim"') ||
      t.parsed.includes('"mint_claim"'),
  );
  const purchaseSucceeded = last.result.capacityEvents.some(
    (e) => e.agentId === "ORCHESTRATOR" && (e.kind === "mint_claim" || e.kind === "pay_with_claim"),
  );
  const buyerWasShutOut = purchaseAttempts.length > 0 && !purchaseSucceeded;

  if (buyerWasShutOut && securedAhead.length === 0) {
    return {
      verdict: "scarcity",
      detail:
        `Window ${WINDOW_COUNT}'s buyer could not buy: ${purchaseAttempts.length} purchase attempt(s), ` +
        `every one of them failed, no single issuer held the ${NOMINAL_JOB_MILLI_SIU} mSIU the job ` +
        `needs (largest: ${largestIssuer} mSIU), and ORCHESTRATOR had secured nothing ahead. This is ` +
        "the scarcity finding." +
        (last.result.passed
          ? ` Note that the window still reports passed=true: a gate was delivered anyway, by ` +
            `${last.result.passedBy ?? "someone"}, without the work ever being paid for. That says ` +
            "nothing about the instrument and must not be read as it working."
          : ""),
    };
  }

  if (last.result.passed) {
    return {
      verdict: "completed",
      detail:
        `Window ${WINDOW_COUNT} delivered its job. Capacity at the largest single issuer when it ` +
        `started: ${largestIssuer} mSIU against a ${NOMINAL_JOB_MILLI_SIU} mSIU job. ` +
        (securedAhead.length > 0
          ? `ORCHESTRATOR had secured capacity ahead with ${securedAhead.length} genuinely ` +
            "forward-dated action(s) — the instrument working as intended, not merely a pool that " +
            "happened to hold out."
          : "ORCHESTRATOR secured nothing ahead; the pool simply still had room, which is not evidence about the instrument."),
    };
  }

  if (!hadCapacity && securedAhead.length === 0) {
    return {
      verdict: "scarcity",
      detail:
        `Window ${WINDOW_COUNT} failed, no single issuer held the ${NOMINAL_JOB_MILLI_SIU} mSIU the ` +
        `job needs (largest: ${largestIssuer} mSIU), and ORCHESTRATOR had secured nothing ahead. ` +
        "This is the scarcity finding: the capacity was gone and nothing had been reserved against it.",
    };
  }

  return {
    verdict: "failed_with_capacity",
    detail:
      `Window ${WINDOW_COUNT} failed, but NOT for want of capacity — ` +
      (hadCapacity
        ? `the largest single issuer held ${largestIssuer} mSIU against a ${NOMINAL_JOB_MILLI_SIU} mSIU job`
        : `ORCHESTRATOR had secured ${securedAhead.length} capacity action(s) in earlier windows`) +
      ". Treat this as a defect to investigate, not as the scarcity result. Halted reasons: " +
      JSON.stringify(last.result.haltedReason),
  };
}

function printRunSummary(
  outcomes: WindowOutcome[],
  forwardBook: ForwardQuoteBook,
  totalOf: (rows: { headroom: string }[]) => bigint,
  budget: ExperimentBudget,
): void {
  console.log("\n\n######## RUN SUMMARY — THREE WINDOWS ########");
  console.log(ONE_POOL_DISCLOSURE);

  console.log("=== PER WINDOW ===");
  for (const o of outcomes) {
    const depletion = o.externalDepletion
      ? o.externalDepletion.txHash
        ? `, then the external buyer took ${o.externalDepletion.requestedMilliSiu} mSIU`
        : `, then the external buyer's scheduled ${o.externalDepletion.requestedMilliSiu} mSIU FAILED (${o.externalDepletion.failedBecause})`
      : "";
    console.log(
      `  window ${o.windowIndex}: passed=${o.result.passed}${o.result.passedBy ? ` by ${o.result.passedBy}` : ""}, ` +
        `headroom ${totalOf(o.headroomBefore)} -> ${totalOf(o.headroomAfter)} mSIU${depletion}`,
    );
    console.log(`    asset choice: ${describeAssetChoice(o.result)}`);
  }

  console.log("\n=== SUBCONTRACTING AND ASSET CHOICE, PER PURCHASE ===");
  for (const o of outcomes) {
    const calls = o.result.turnLogsByAgent.ORCHESTRATOR ?? [];
    const purchases = calls.filter(
      (t) =>
        t.parsed.includes('"pay"') ||
        t.parsed.includes('"pay_with_claim"') ||
        t.parsed.includes('"mint_claim"'),
    );
    if (purchases.length === 0) {
      console.log(`  window ${o.windowIndex}: no purchase.`);
      continue;
    }
    for (const t of purchases) {
      const route = t.parsed.includes('"pay"') ? "USDC" : "fSIU";
      console.log(`  window ${o.windowIndex} turn ${t.turn}: ${route} — ${t.parsed.slice(0, 160)}`);
    }
  }

  console.log("\n=== CAPACITY EVENTS (claims and reservations, with tx hashes) ===");
  let anyEvent = false;
  for (const o of outcomes) {
    for (const e of o.result.capacityEvents) {
      anyEvent = true;
      console.log(
        `  w${o.windowIndex} turn ${e.turn} ${e.agentId} ${e.kind}${describeCapacityEvent(e)}`,
      );
    }
    if (o.externalDepletion?.txHash) {
      console.log(
        `  w${o.windowIndex} [EXTERNAL BUYER, not an agent] mint ${o.externalDepletion.requestedMilliSiu} mSIU — tx ${o.externalDepletion.txHash}`,
      );
      anyEvent = true;
    }
  }
  if (!anyEvent) console.log("  none.");

  console.log("\n=== ADVERSARY ===");
  for (const o of outcomes) {
    console.log(
      `  window ${o.windowIndex}: gate versions delivered ${o.result.gateVersions.length}` +
        (o.result.gateVersions.length > 0
          ? ` (${o.result.gateVersions.map((g) => `v${g.version} by ${g.submittedBy} on turn ${g.turn}`).join("; ")})`
          : ""),
    );
    if (o.result.attacks.length === 0) {
      console.log("    attacks: none.");
      continue;
    }
    for (const a of o.result.attacks) {
      console.log(
        `    turn ${a.turn} by ${a.attacker} vs gate v${a.gateVersion}: ${a.classification} ` +
          `(gate accepted=${a.gateAccepted}, oracle accepted=${a.oracleAccepted}) — ${a.reason}`,
      );
    }
    // Whether a revision actually closed a hole, rather than merely following one: a false accept
    // against version N that no longer reproduces against version N+1 is the only evidence that
    // the revision did anything.
    const yieldsByVersion = new Map<number, number>();
    for (const a of o.result.attacks) {
      if (a.countsAsAdversaryYield) {
        yieldsByVersion.set(a.gateVersion, (yieldsByVersion.get(a.gateVersion) ?? 0) + 1);
      }
    }
    for (const [version, count] of [...yieldsByVersion].sort(([a], [b]) => a - b)) {
      const later = o.result.attacks.filter((a) => a.gateVersion > version);
      const laterYields = later.filter((a) => a.countsAsAdversaryYield).length;
      console.log(
        `    v${version}: ${count} false accept(s). ` +
          (later.length === 0
            ? "No later version was tested, so whether a revision would have closed them is unknown — not that it did."
            : `A later version was tested ${later.length} time(s) with ${laterYields} false accept(s).`),
      );
    }
  }

  console.log("\n=== FORWARD TERMS (stated prices, not contracts — nothing enforces one) ===");
  const quotes = forwardBook.all();
  // The negative has to be attributable: "prompted and declined" and "never asked" are different
  // findings, and a report that says only "nobody quoted" cannot tell them apart.
  const invitationsByAgent = new Map<string, number>();
  for (const o of outcomes) {
    for (const inv of o.result.forwardInvitations) {
      invitationsByAgent.set(inv.agentId, (invitationsByAgent.get(inv.agentId) ?? 0) + 1);
    }
  }
  if (invitationsByAgent.size === 0) {
    console.log(
      "  No agent was ever shown the invitation to state forward terms. NOBODY WAS ASKED — this is " +
        "not evidence that issuers decline to quote. Check the tool grants and the wait-gate before " +
        "reading anything into it.",
    );
  } else {
    for (const [agentId, count] of [...invitationsByAgent].sort()) {
      const stated = quotes.filter((q) => q.issuer === agentId).length;
      console.log(
        `  ${agentId}: shown the invitation on ${count} turn(s), stated ${stated} offer(s)` +
          (stated === 0 ? " — PROMPTED AND DECLINED, not un-asked." : ""),
      );
    }
  }
  if (quotes.length === 0) {
    console.log("  No forward terms were stated in any window.");
  } else {
    for (const q of quotes) {
      console.log(
        `  ${q.quoteId}: ${q.issuer} stated in window ${q.statedInWindow} for window ${q.forWindow} — ` +
          `${q.rateUsdPerSiu} USD/SIU, up to ${q.maxQuantityMilliSiu} mSIU ` +
          `(their real headroom then: ${q.issuerHeadroomAtQuote} mSIU) — ` +
          (q.takenInWindow === null
            ? "NOT taken"
            : `taken by ${q.takenBy} in window ${q.takenInWindow}`),
      );
    }
    const taken = quotes.filter((q) => q.takenInWindow !== null).length;
    console.log(`  ${taken} of ${quotes.length} offers were taken.`);
  }

  console.log("\n=== SCARCITY, AND WHAT THE LAST WINDOW'S OUTCOME ACTUALLY MEANS ===");
  const last = outcomes.at(-1);
  if (last) {
    console.log(`  code-class headroom remaining at the end: ${totalOf(last.headroomAfter)} mSIU`);
    console.log(
      `  per issuer: ${last.headroomAfter.map((r) => `${r.issuer} ${r.headroom}`).join(", ")}`,
    );
    console.log(
      "  A claim routes to a single issuer with enough headroom by itself, so the per-issuer split " +
        "above, not the total, is what a late buyer faces.",
    );
  }
  const verdict = classifyFinalWindow(outcomes);
  console.log(`  VERDICT: ${verdict.verdict}`);
  console.log(`  ${verdict.detail}`);

  console.log("\n=== HALTS, REFUSALS AND FRICTION ===");
  for (const o of outcomes) {
    const halts = Object.entries(o.result.haltedReason ?? {});
    const refusals = halts.filter(([, reason]) => reason === "policy_refusal");
    console.log(
      `  window ${o.windowIndex}: ${halts.length === 0 ? "no halts" : halts.map(([a, r]) => `${a}=${r}`).join(", ")}` +
        (refusals.length > 0
          ? `  <-- POLICY REFUSALS: ${refusals.map(([a]) => a).join(", ")}`
          : ""),
    );
  }
  console.log(
    `  Friction logs (self-reported, per turn, including time_to_expiry_seconds) are at ` +
      `${RUNS_ROOT}/<runId>-w<N>/friction/friction-log.jsonl — every turn, not only the ones that acted.`,
  );

  console.log("\n=== SPEND ===");
  const byProvider: Record<string, number> = {};
  for (const o of outcomes) {
    for (const [provider, usd] of Object.entries(o.result.spendByProvider)) {
      byProvider[provider] = (byProvider[provider] ?? 0) + Number(usd);
    }
  }
  for (const [provider, usd] of Object.entries(byProvider).sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  ${provider}: $${usd.toFixed(6)}`);
  }
  console.log(`  run total: $${budget.runTotalUsd()} of the $${RUN_CAP_USD} cap`);
  console.log(`  experiment ledger total now: $${budget.experimentTotalUsd()}`);
}

/** Only when run as a script — `buildRoster` and the schedule constants are imported by tests,
 * and importing this module must never start a real, paid, on-chain run. */
if (process.argv[1]?.endsWith("p5-three-window-full-run.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
