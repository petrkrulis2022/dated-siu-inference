import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, createPublicClient, http, keccak256, stringToBytes, type Hex } from "viem";
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
  type FullRunWindowResult,
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
 * Window 3 is allowed to fail. If the pool is exhausted when window 3 starts, the job does not get
 * done and the run reports that as its result. Nothing here tops the pool back up, re-sizes a lot,
 * or quietly routes around the shortage — a scarcity experiment whose scarcity is relieved the
 * moment it binds measures nothing. This is stated here, in docs/gate-market-spec.md §4.5, and in
 * the run's own output before the first window starts, so the outcome cannot be reinterpreted
 * afterwards.
 */

const RUN_CAP_USD = "40";
const EXPERIMENT_CAP_USD = "150";
export const WINDOW_COUNT = 3;
/** Each window is one real, compressed hour — spec §9.2's "three weekly windows", shortened so a
 * run completes in an afternoon rather than three weeks. */
const WINDOW_SECONDS = 3600n;

/**
 * The simulated external buyer's schedule, in mSIU of `code`-class capacity taken between
 * windows. It is a schedule, not a reaction: these numbers are fixed here before the run starts,
 * printed before window 1, and written into the manifest, so no agent's behaviour changes them
 * and nobody can claim afterwards that the depletion was tuned to the result.
 *
 * Sized against the live pool (24,000 mSIU ISSUER-A + 16,000 ISSUER-B = 40,000): 14,000 after
 * window 1 and 14,000 after window 2 leave 12,000 mSIU, split 10,000/2,000 across the two
 * issuers. That last detail matters and is disclosed to the agents too — `ClaimRouter` routes a
 * mint to a *single* issuer with enough headroom, so 12,000 mSIU spread over two issuers cannot
 * serve one 12,000 mSIU claim. A fragmented pool is a real property of this design, not a bug.
 *
 * The external buyer is the deployer wallet, which is not an agent, makes no decisions and has no
 * model. It is labelled as such everywhere it appears.
 */
export const EXTERNAL_DEPLETION_MILLI_SIU: Record<number, number> = { 1: 14_000, 2: 14_000 };

interface WindowOutcome {
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

  const startingHeadroom = await headroomRows();
  console.log("=== WP-7 P5 — THREE WINDOWS, ONE POOL ===");
  console.log(`Run ${runId} (label ${runSeed}); oracle trial seed ${F1_ORACLE_TRIAL_SEED} (pinned).`);
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
  console.log(ONE_POOL_DISCLOSURE);

  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: modelAssignment,
    seed: `p5-three-window:${runSeed}`,
    oracleTrialSeed: F1_ORACLE_TRIAL_SEED,
    externalDepletionMilliSiu: EXTERNAL_DEPLETION_MILLI_SIU,
    windowCount: WINDOW_COUNT,
  };

  const outcomes: WindowOutcome[] = [];

  for (let windowIndex = 1; windowIndex <= WINDOW_COUNT; windowIndex++) {
    const nowSeconds = await chainReader.currentBlockTimestamp();
    const windowFrom = nowSeconds - 60n;
    const windowTo = nowSeconds + WINDOW_SECONDS;
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
      publisherPrivateKeyHex: toHex(process.env.TOUCHSTONE_PUBLISHER_KEY, "TOUCHSTONE_PUBLISHER_KEY"),
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
  capacityLots: Record<string, { measuredRateMilliSiuPerHour: number; committedCapacityHours: number; bondedUsdcPerClass: number }>;
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
    windowIndex, headroomBefore, taskSpecHash, rateUsdPerSiu, printId, models, adapters,
    addresses, keys, rpcUrl, registryEntry, workerCodeErc8004Id, workerExtractErc8004Id,
    capacityLots, windowFrom, windowTo,
  } = input;

  const isLastWindow = windowIndex === WINDOW_COUNT;
  const poolText = headroomBefore
    .map((r) => `${r.issuer}: ${r.headroom} mSIU`)
    .join("; ");
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

  Once a claim mints against you and its holder presents it, YOU owe the real delivery — never the
  holder. Once you see "A CLAIM WAS PRESENTED AGAINST YOU" with its real tokenId/holder/quantity,
  do the work yourself with submit_job until it genuinely passes, then call serve_redemption to
  report ONLY the pass. Never report a fail: an undelivered claim defaults against your own bond
  automatically once the window closes.

${forwardSection}

  If you have nothing to do yet, DO NOT respond with {"done": true} — you would miss a real
  redemption routed to you later. Check again with a harmless read:
  {"tool": "get_print", "args": {"printId": "${printId}"}}.
${runShapeFacts}`;
  };

  const issuerTools: RosterAgentConfig["availableTools"] = isLastWindow
    ? ["mint_claim", "submit_job", "serve_redemption", "check_headroom", "get_print"]
    : ["mint_claim", "submit_job", "serve_redemption", "check_headroom", "get_print", "quote_forward"];

  return [
    {
      agentId: "ORCHESTRATOR",
      adapter: adapters.ORCHESTRATOR,
      modelString: models.ORCHESTRATOR,
      prices: PRICES[models.ORCHESTRATOR],
      skillPackText: `${loadSkill("subcontract-and-settle").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${orchestratorBrief}`,
      availableTools: [
        "request_quote", "pay", "pay_with_claim", "mint_claim", "transfer_claim",
        "check_headroom", "take_forward", "submit_job", "get_balances", "get_print",
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
        "issue_quote", "reserve_for_work", "settle_escrow", "submit_job", "pay",
        "redeem_claim", "get_balances", "get_print",
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
      availableTools: ["issue_quote", "settle_escrow", "submit_attack", "get_balances", "get_print"],
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
      maxOutputTokens: 1500,
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
    const account = privateKeyToAccount(toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY"));
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(input.rpcUrl) });
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

  const orchestratorCalls = (result.turnLogsByAgent.ORCHESTRATOR ?? []).map((t) => t.parsed);
  const paid = orchestratorCalls.some((p) => p.includes('"pay"'));
  const claimed =
    orchestratorCalls.some((p) => p.includes('"pay_with_claim"')) ||
    orchestratorCalls.some((p) => p.includes('"mint_claim"'));
  console.log(
    `F1 read: ${
      paid && claimed
        ? "ORCHESTRATOR used BOTH routes this window"
        : paid
          ? "ORCHESTRATOR chose USDC"
          : claimed
            ? "ORCHESTRATOR chose fSIU"
            : "ORCHESTRATOR reached no asset-choice action this window"
    }`,
  );

  if (result.attacks.length === 0) {
    console.log("attacks: none this window.");
  } else {
    const yields = result.attacks.filter((a) => a.countsAsAdversaryYield).length;
    console.log(
      `attacks: ${result.attacks.length}, of which ${yields} false accepts (the adversary's real yield).`,
    );
  }
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
  }

  console.log("\n=== FORWARD TERMS (stated prices, not contracts — nothing enforces one) ===");
  const quotes = forwardBook.all();
  if (quotes.length === 0) {
    console.log("  No issuer stated forward terms in any window. That is a result, not a gap: the");
    console.log("  tool was available to both issuers in windows 1 and 2 and neither used it.");
  } else {
    for (const q of quotes) {
      console.log(
        `  ${q.quoteId}: ${q.issuer} stated in window ${q.statedInWindow} for window ${q.forWindow} — ` +
          `${q.rateUsdPerSiu} USD/SIU, up to ${q.maxQuantityMilliSiu} mSIU ` +
          `(their headroom then: ${q.issuerHeadroomAtQuote} mSIU) — ` +
          (q.takenInWindow === null ? "NOT taken" : `taken by ${q.takenBy} in window ${q.takenInWindow}`),
      );
    }
    const taken = quotes.filter((q) => q.takenInWindow !== null).length;
    console.log(`  ${taken} of ${quotes.length} offers were taken.`);
  }

  console.log("\n=== SCARCITY ===");
  const last = outcomes.at(-1);
  if (last) {
    const remaining = totalOf(last.headroomAfter);
    console.log(`  code-class headroom remaining at the end of the run: ${remaining} mSIU`);
    console.log(
      `  per issuer: ${last.headroomAfter.map((r) => `${r.issuer} ${r.headroom}`).join(", ")}`,
    );
    console.log(
      "  A claim routes to a single issuer with enough headroom by itself, so the per-issuer split " +
        "above, not the total, is what a late buyer actually faces.",
    );
  }
  const failedWindows = outcomes.filter((o) => !o.result.passed).map((o) => o.windowIndex);
  console.log(
    failedWindows.length === 0
      ? "  Every window's job was delivered."
      : `  Windows that did not get their job delivered: ${failedWindows.join(", ")}. This was ` +
          "disclosed as an allowed outcome before the run started; nothing topped the pool back up.",
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
  console.log(`  run total: $${budget.runTotalUsd()} of $${RUN_CAP_USD}`);
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
