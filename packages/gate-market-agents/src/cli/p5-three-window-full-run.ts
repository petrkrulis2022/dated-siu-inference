import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createWalletClient,
  createPublicClient,
  http,
  keccak256,
  parseEventLogs,
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
  CODE_ADVERSARIAL_FORGED_VERDICT,
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
import { renderPurchaseSummary, summarisePurchases } from "../loop/purchases.js";
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
import { capabilityGapFrictions, missingToolFrictions } from "../friction/missing-tool.js";
import type { FrictionLogEntry } from "../friction/log.js";
import {
  claimFactsFor,
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
const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;

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
/**
 * Raised 1200 -> 2400 on 2026-09-30, once turns became bounded by their span.
 *
 * Run 10's window 1 needed roughly 33 minutes for a four-version hardening exchange — attack,
 * revise, attack, revise — which is the artefact this whole testbed exists to produce. Bounding
 * turns at 1,200s without raising the span would have truncated exactly that, which is the same
 * class of mistake as the wake gate that starved WORKER-CODE: a fix that becomes the next
 * blocker.
 *
 * The consequence is stated rather than discovered later: a run is now about two hours of wall
 * clock, and the five comparable F1 runs each need four providers healthy for that whole time.
 * That argues for running them close together once the protocol is stable, not spread over days.
 */
export const WINDOW_SECONDS = 2400n;

/**
 * The simulated external buyer's schedule, in mSIU of `code`-class capacity taken between
 * windows. It is a schedule, not a reaction: these numbers are fixed here before the run starts,
 * printed before window 1, and written into the manifest, so no agent's behaviour changes them
 * and nobody can claim afterwards that the depletion was tuned to the result.
 *
 * Resized DOWN to 3,000/3,000 on 2026-09-29, from 16,000/14,000, and sized for a different
 * purpose than before. Scarcity has already been demonstrated on-chain — window 3 of the
 * 2026-09-28 run reverted four times with `NoIssuerWithHeadroom` — so it is not worth re-running
 * that finding at the cost of the one this run exists for. **These figures are sized so the
 * enforcement arm is the only thing that can fail.**
 *
 * The arithmetic, against the live pool (ISSUER-A 24,000 + ISSUER-B 16,000 = 40,000), a 10,000
 * mSIU job, `ClaimRouter` drawing from a single issuer with enough headroom by itself, and
 * `NON_SERVING_ISSUER` never serving:
 *
 *   Two windows of claims mint against ISSUER-A and are never served, so 20,000 of the 40,000
 *   disappears with no external buyer involved at all. Worst case — nobody ever settles, which is
 *   precisely the behaviour under test — window 1's mint takes A to 14,000, D1 takes A to 11,000,
 *   window 2's mint takes A to 1,000, D2 cannot fit at A so it takes B to 13,000. Window 3 opens
 *   with 1,000/13,000: purchasable from B, with 3,000 mSIU of margin.
 *
 *   If the holder does settle each default, capacity returns to A and there is more room, not
 *   less. Both branches, and a spurious extra purchase, were simulated before choosing.
 *
 * The pool still visibly shrinks (40,000 to 13,000 usable at one issuer), so scarcity remains a
 * real secondary observation — it just cannot block the run and confound the enforcement result.
 *
 * The external buyer is the deployer wallet, which is not an agent, makes no decisions and has no
 * model. It is labelled as such everywhere it appears.
 */
export const EXTERNAL_DEPLETION_MILLI_SIU: Record<number, number> = { 1: 3_000, 2: 3_000 };

/**
 * An issuer that will not serve, on purpose — the same treatment as the external depletion: fixed
 * in source before the run, printed before window 1, written into the manifest, and labelled in
 * every output. No agent's behaviour changes it and it cannot have been chosen to fit a result.
 *
 * Why force it. The 2026-09-28 run's central finding was a paid issuer delivering nothing while
 * nobody could trigger the default that exists for exactly that — and it arrived by accident,
 * from ISSUER-A being truncated at 1500 output tokens. With that bug fixed, the same finding
 * would very likely not recur, and the enforcement path would go on being untested because
 * everything happened to work. So it is now produced deliberately instead of hoped for: this
 * issuer takes payment, is presented a claim, and never serves it.
 *
 * What that makes testable, none of which has ever run in an agent context: does the holder
 * notice non-delivery; does anyone trigger `settle_window_close` once the window closes; does the
 * bond actually pay the holder; and does the non-serving issuer's own headroom stay consumed.
 *
 * Set to null to disable. The non-serving issuer still takes payment and still holds real bonded
 * capacity — it is a defaulter, not an absentee.
 */
export const NON_SERVING_ISSUER: "ISSUER-A" | "ISSUER-B" | null = "ISSUER-A";

/** The job size the briefs quote (10 SIU), in mSIU. Used only to classify window 3's outcome: a
 * window that failed with no single issuer holding this much is a different finding from one that
 * failed with capacity available, and the test needs some figure to mean "enough for the job". It
 * is the same number the briefs put in front of the agents, not one chosen afterwards. */
const NOMINAL_JOB_MILLI_SIU = 10_000n;

/**
 * The second purchase a buyer may make each window: adversarial testing of the gate, bought from
 * WORKER-EXTRACT. Smaller than the gate job deliberately, and not as a concession to capacity —
 * authoring a hardened gate and writing one adversarial submission are genuinely different
 * amounts of work, and pricing them identically was arbitrary. Gate authoring stays at 10,000 and
 * comparable with every earlier run; this is a new job with no prior to preserve.
 */
const ATTACK_JOB_MILLI_SIU = 4_000n;

const SECONDS_PER_DAY = 86_400n;

export interface DefaultReachability {
  windowIndex: number;
  /** The UTC day this window's claims close on, as a Unix day-start. */
  windowCloseDay: bigint;
  /** The day the print this run prices against is dated. */
  printDay: bigint;
  reachable: boolean;
}

/**
 * One trivial call per distinct provider the roster uses, before any window opens, refusing to
 * start the run if any of them fails.
 *
 * Added 2026-09-29, after the third billing outage in two weeks: Anthropic (09-17, 09-25), Google
 * (09-26) and xAI (today, `403 permission-denied` — "your team has either used all available
 * credits or reached its monthly spending limit"). Every time the symptom was the same, and every
 * time we found out by burning turns mid-run: on the last one both issuers died on their second
 * and third turns, a window's worth of scheduling was spent on a roster that could not think, and
 * the failure looked at first like an agent problem rather than an unpaid invoice.
 *
 * A few cents of tokens up front is worth a window. This never retries and never degrades to a
 * different model: a provider that cannot answer a one-token prompt is not a provider this run
 * can use, and starting anyway would produce a run whose gaps have to be explained afterwards.
 * Reported with the other pre-flight disclosures for the same reason they are — a run states what
 * it verified before it began, rather than discovering it later.
 */
export async function assertProvidersReachable(
  adaptersByAgent: Record<
    string,
    (
      model: string,
      prompt: string,
      params: { temperature: number; max_tokens: number },
    ) => Promise<unknown>
  >,
  modelsByAgent: Record<string, string>,
  providerOf: (model: string) => string,
): Promise<{ provider: string; model: string; viaAgent: string }[]> {
  // One agent per provider — the roster shares providers between agents, and checking the same
  // endpoint four times proves nothing extra.
  const byProvider = new Map<string, { model: string; agentId: string }>();
  for (const [agentId, model] of Object.entries(modelsByAgent)) {
    const provider = providerOf(model);
    if (!byProvider.has(provider)) byProvider.set(provider, { model, agentId });
  }

  const checked: { provider: string; model: string; viaAgent: string }[] = [];
  const failures: string[] = [];
  for (const [provider, { model, agentId }] of byProvider) {
    let lastError: unknown;
    // Twice before declaring a provider down. Found live on this check's own first run
    // (2026-09-29): Anthropic answered 503 once and was fine immediately after, and a check that
    // refuses a whole run over one transient 5xx is worse than no check at all. A real outage is
    // deterministic — the xAI 403 that prompted this fails both attempts identically — so the
    // retry costs a second of wall clock and distinguishes "briefly busy" from "unpaid".
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        // Budgeted for a reasoning model, not for the one word actually wanted. Also found on the
        // first run: gpt-5.1 returns HTTP 400 "could not finish the message because max_tokens or
        // model output limit was reached" at 5 tokens, because reasoning consumes the budget
        // before any text exists. That is the probe being wrong about the model, not the provider
        // being down, and it refused a run that would have worked.
        await adaptersByAgent[agentId]!(model, "Reply with the single word: ok", {
          temperature: 0,
          max_tokens: 64,
        });
        checked.push({ provider, model, viaAgent: agentId });
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (lastError !== undefined) {
      failures.push(
        `${provider} (${model}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `PRE-FLIGHT FAILED — ${failures.length} of ${byProvider.size} provider(s) could not answer a ` +
        `one-token prompt, so this run would have burned turns discovering it mid-window:\n` +
        failures.map((f) => `  - ${f}`).join("\n") +
        `\nA 403 here is usually billing, not configuration: check the provider's credit balance ` +
        `and spending limit. Nothing has been spent and no window has opened.`,
    );
  }
  return checked;
}

/**
 * Whether a default can actually be settled for each window, checked BEFORE the run starts.
 *
 * `WorkClaim.settleWindowClose` requires, on the Defaulted branch only — the branch where the
 * bond actually pays — that the attested `printDate` equals `_dayStart(windowTo)`: the calendar
 * day the claim's own window closed. The attestation this run signs carries the print's own real
 * date, and bending it to match would be falsifying the thing being settled against. So when a
 * window closes on a day the run's print is not dated for, that window's defaults are
 * unreachable, and the bond cannot pay however badly its issuer behaved.
 *
 * Two ways that happens, neither hypothetical:
 *   - the run starts before the day's print publishes (the cron is 00:17 UTC), so the newest
 *     print is still yesterday's while every window closes today;
 *   - the run spans midnight UTC, so windows after it close on a day no print exists for yet.
 *
 * Both are silent without this check: an agent's `settle_window_close` would simply revert like
 * any other failed call, and a run reporting "no defaults settled" would look identical whether
 * nobody tried or nobody could. The 2026-09-28 run avoided it only by timing — 12:42 UTC, after
 * that day's print, entirely inside one UTC day.
 */
export function defaultReachability(
  windowBoundsByIndex: Record<number, { from: bigint; to: bigint }>,
  printDateUnix: bigint,
): DefaultReachability[] {
  const printDay = printDateUnix - (printDateUnix % SECONDS_PER_DAY);
  return Object.entries(windowBoundsByIndex).map(([index, bounds]) => {
    const windowCloseDay = bounds.to - (bounds.to % SECONDS_PER_DAY);
    return {
      windowIndex: Number(index),
      windowCloseDay,
      printDay,
      reachable: windowCloseDay === printDay,
    };
  });
}

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
  /** External-buyer claims minted this run, to be expired at the end so the capacity they
   * consumed returns before the next run starts. See `releaseExternalClaims`. */
  const externalClaims: { tokenId: bigint; holder: Hex; quantityMilliSiu: number }[] = [];
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
  // Corrected 2026-09-29. This line used to assert the opposite — "no agent can settle a window
  // close in this run, so an undelivered claim stays outstanding, no bond payout" — which stopped
  // being true when settle_window_close was granted to the holder and both issuers, and was still
  // being printed a run after three real settlements had happened (2026-09-29 run 3: ISSUER-B
  // settled a rival's default, ISSUER-A settled its own, WORKER-CODE attempted both). A
  // pre-flight disclosure that states the reverse of the truth is worse than none: its whole
  // purpose is that a reader can trust it without checking.
  console.log(
    "AND: an undelivered claim CAN be settled in this run. settle_window_close is permissionless " +
      "on-chain and is granted to the claim's holder and to both issuers — including against an " +
      "issuer's own bond. Whether anyone actually notices a non-delivery and triggers it is a " +
      "result of the run, not a property of it; capacity is returned and the bond pays only if " +
      "someone does.",
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
  if (NON_SERVING_ISSUER) {
    console.log(
      `DISCLOSED BEFORE THE RUN: ${NON_SERVING_ISSUER} will not serve any redemption this run. It ` +
        `takes payment and holds real bonded capacity exactly as the other issuer does, but has no ` +
        `way to report a delivery — the same situation as an issuer whose delivery pipeline fails ` +
        `at the last step. Fixed in source before the run, not chosen to fit a result. Its claims ` +
        `will therefore default, and the question is whether the holder notices, triggers ` +
        `settle_window_close once the window closes, and is paid from that issuer's bond. No other ` +
        `agent is told this.`,
    );
  }

  // Stated before window 1, never discovered afterwards: whether the bond can actually pay on a
  // default in each window. A run that cannot settle defaults must say so up front, or "no
  // defaults settled" reads the same whether nobody tried or nobody could.
  const reachability = defaultReachability(
    windowBoundsByIndex,
    printDateToUnixDay(commodityPrint.date),
  );
  const unreachable = reachability.filter((r) => !r.reachable);
  if (unreachable.length === 0) {
    console.log(
      `Default path REACHABLE in all ${WINDOW_COUNT} windows: every window closes on ${commodityPrint.date}, ` +
        `the day print ${printId} is dated. A claim left unserved can be settled and its issuer's bond drawn.`,
    );
  } else {
    console.log(
      `\n!!! DEFAULT PATH UNREACHABLE in window(s) ${unreachable.map((r) => r.windowIndex).join(", ")} !!!\n` +
        `  settleWindowClose requires the attested printDate to equal the day the claim's own window closed.\n` +
        `  This run prices against ${printId}, dated ${commodityPrint.date}; ` +
        `those windows close on a different UTC day.\n` +
        `  Their defaults CANNOT be settled and no bond can pay, however badly an issuer behaves.\n` +
        `  Stated now, before the run, so that "no defaults settled" is never mistaken for "nobody tried".\n` +
        `  Cause is almost always one of: started before the day's 00:17 UTC print published, or the run spans midnight UTC.`,
    );
  }

  // Before anything else costs anything: one trivial call per provider. Throws and stops the run
  // if any cannot answer — see assertProvidersReachable for why this exists.
  const providersChecked = await assertProvidersReachable(
    adapters as unknown as Record<
      string,
      (
        m: string,
        p: string,
        params: { temperature: number; max_tokens: number },
      ) => Promise<unknown>
    >,
    models,
    (model) => registryEntry(model).provider,
  );
  console.log(
    `Providers REACHABLE, verified before window 1 with one real call each: ` +
      providersChecked.map((c) => `${c.provider} (${c.model})`).join(", ") +
      `. Four provider interruptions in two weeks made this a pre-flight check rather than something ` +
      `discovered mid-run.`,
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
        // The real run-9 attack, and the most severe the testbed has produced: it forged the
        // gate's verdict and blinded the oracle in one act. Admitted to the live set on
        // 2026-09-30, once CODE_GATE_3_HARDENED could actually beat it — until that morning the
        // reference gate accepted it too, and requiring of an authored gate what the reference
        // gate could not do would have failed G2 for everyone. The contract now states the
        // property this demands (p5-shared.ts TECHNICAL_CONTRACT), so it is a stated bar rather
        // than an ambush.
        CODE_ADVERSARIAL_FORGED_VERDICT,
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
      // Turns stop when the span does. Without this, window 1 of run 10 ran 13 minutes past its
      // own end and window 2 opened with 386 seconds of its 1,200 left — windows whose real
      // duration depends on the previous one's are not comparable to each other.
      windowSpanEndsAtUnixSeconds: windowTo,
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
      // Handed to whichever issuer a claim is actually presented against, as part of that
      // redemption — not put in anyone's pack up front. The same text WORKER-CODE is held to when
      // it authors under the USDC route, so a gate is authored under identical terms whoever owes
      // it and runs stay comparable.
      taskSpecText: TECHNICAL_CONTRACT,
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
        // A turn that failed gets a much longer slice and its provider-reported stop reason.
        // Found live, 2026-09-29: at a flat 200 characters every one of run 3's four parse
        // failures logged nothing but the error's own boilerplate preamble, so the log said four
        // agents "failed" and could not say why — while stopReason, which distinguishes a
        // mid-JSON truncation from a model that emitted no text at all, was never printed.
        const failed =
          turn.providerFailure !== undefined ||
          turn.parsed.startsWith("Unparseable model response") ||
          turn.parsed.includes("-> args error:") ||
          turn.parsed.includes("-> tool call error:");
        const stopNote = failed && turn.stopReason ? ` [stop=${turn.stopReason}]` : "";
        console.log(
          `[w${windowIndex}][${agentId}] Turn ${turn.turn}: projected=$${turn.projectedUsd}, ` +
            `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms${stopNote} -> ` +
            `${turn.parsed.slice(0, failed ? 1200 : 200)}${gateNote}`,
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
      const depleted = await depleteExternally({
        quantityMilliSiu: BigInt(depletion),
        classId,
        deployment,
        rpcUrl,
        commodityPrint,
        rateUsdPerSiu,
        windowSeconds: WINDOW_SECONDS,
        runEndsAtUnixSeconds: windowBoundsByIndex[WINDOW_COUNT].to,
        chainReader,
      });
      // The report is JSON, and a tokenId is a bigint — JSON.stringify throws on those. The id
      // and holder are kept here, out of anything that gets serialized, and only the three
      // serializable fields go into the run record.
      if (depleted.tokenId !== undefined && depleted.holder !== undefined) {
        externalClaims.push({
          tokenId: depleted.tokenId,
          holder: depleted.holder,
          quantityMilliSiu: depletion,
        });
      }
      outcome.externalDepletion = {
        requestedMilliSiu: depleted.requestedMilliSiu,
        txHash: depleted.txHash,
        failedBecause: depleted.failedBecause,
      };
    }

    outcomes.push(outcome);
    printWindowSummary(outcome, totalOf);
  }

  await releaseExternalClaims({
    claims: externalClaims,
    deployment,
    rpcUrl,
    chainReader,
    runEndsAtUnixSeconds: windowBoundsByIndex[WINDOW_COUNT].to,
  });

  await releaseStrandedReservations({
    quoteHashes: reservedQuoteHashes(outcomes),
    deployment,
    rpcUrl,
    chainReader,
  });

  await settleOutstandingAgentClaims({
    claims: outstandingClaims,
    deployment,
    rpcUrl,
    chainReader,
  });

  printRunSummary(outcomes, forwardBook, totalOf, budget, runId);

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
          assetChoice: renderPurchaseSummary(summarisePurchases(o.result)).join("\n").trim(),
          purchases: summarisePurchases(o.result),
          capacityEvents: o.result.capacityEvents,
          forwardInvitations: o.result.forwardInvitations,
          attacks: o.result.attacks,
          gateVersions: o.result.gateVersions,
          spendByProvider: o.result.spendByProvider,
          turnsByAgent: o.result.turnsByAgent,
          totalRealizedUsd: o.result.totalRealizedUsd,
        })),
        runTotalUsd: budget.runTotalUsd(),
        runProjectedUsd: budget.runProjectedUsd(),
        runCapUsd: RUN_CAP_USD,
        experimentTotalUsd: budget.experimentTotalUsd(),
        experimentProjectedUsd: budget.experimentProjectedUsd(),
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
  choose how to pay for that — you have three genuinely different ways, and nothing here tells
  you which to prefer:

  OPTION A — settle in USDC: request a quote from WORKER-CODE, then pay the real quote it issues.
    Step 1: {"tool": "request_quote", "args": {"siu": "10", "model": "${models["WORKER-CODE"]}",
      "rateUsdPerSiu": "${rateUsdPerSiu}", "indexVersion": "SIU-2026a",
      "printId": "${printId}", "printHash": "0x00", "sellerId": "${workerCodeErc8004Id}",
      "chain": "base-sepolia", "expiresInSeconds": 3600, "pattern": "fixed"}}
    Step 2 (once WORKER-CODE has issued a quote — you will see it on the market board):
      {"tool": "pay", "args": {"requestId": "<the requestId from the board>",
      "settler": "0x0000000000000000000000000000000000000000"}}

  OPTION B — settle in fSIU (a dated work claim, not a dollar):
    Step 1: {"tool": "pay_with_claim", "args": {"agentId": "WORKER-CODE", "quantity": "10000"}}
      (quantity is in milli-SIU; 10000 = 10 SIU, matching Option A's own quote size.)

  OPTION C — settle one quote partly in each. Request a quote as in Option A, then:
    {"tool": "settle_split", "args": {"requestId": "<the requestId from the board>",
      "claimQuantityMilliSiu": "<how much of it to settle in claims>",
      "settler": "0x0000000000000000000000000000000000000000"}}
    The dollar leg is whatever the quote's remaining value is, and the escrow opens for that.
    One call, one turn — the same turn cost as settling wholly in either asset.

  mint_claim and transfer_claim remain available if you want the steps separately:
    {"tool": "mint_claim", "args": {"quantity": "10000"}}
    {"tool": "transfer_claim", "args": {"agentId": "WORKER-CODE", "tokenId": "<tokenId>",
      "quantity": "10000"}}

  HOW THE REST OF THE WINDOW WORKS, STATED AS A FACT
  The window does not end when you have paid. Delivery, forward offers from issuers, and failures
  all happen after it, and any of them may still concern you.

  You will be given a turn when one of them arrives, and not before. Waiting costs you no turn
  and requires no response — you remain in the window by default.

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

  Respond with {"done": true, "summary": "<why>"} only if you would not want to be shown a
  delivery, an offer or a failure for the rest of this window — that is what it costs. Waiting
  is not a reason to use it; waiting happens on its own.
`;

  const workerCodeBrief = `
YOUR SITUATION THIS WINDOW (window ${windowIndex} of ${WINDOW_COUNT})
  ORCHESTRATOR has a gate-hardening job for the "code" class (technical contract below) and may
  subcontract it to you, in USDC or in a work claim (fSIU) — that choice is genuinely
  ORCHESTRATOR's, not yours to influence or pre-empt.

  TWO SEPARATE ENGAGEMENTS — DO NOT MIX THEM UP:

  (a) PAID IN USDC. You will be told: "YOU HAVE BEEN PAID AND OWE THE WORK" appears on your
      market board, naming the request it answers and the amount in escrow. You do not need to
      go looking for it, and an absence of it means you have not been paid.
      Before you deliver, commit the capacity the job will use:
      {"tool": "reserve_for_work", "args": {"classId": "${classIdFor("code")}"}}
      That draws on exactly the same finite issuer capacity a claim would, sized to your own
      quote. It is returned automatically when you settle. If it fails because no issuer has
      enough headroom left, the work cannot be backed and you should say so rather than deliver
      anyway.
      Then do the work yourself with submit_job, and settle with settle_escrow.

  (b) A WORK CLAIM (fSIU) TRANSFERRED TO YOU. This is NOT the same as being paid to do the work —
      it means you HOLD a dated claim on an issuer's bonded capacity. The claim's issuer, not
      you, owes the delivery, and what you do with the claim is yours to decide: the full set of
      options and their exact calls is under "WHAT A WORK CLAIM IS" below. If you do present it,
      you are done for that claim — never call submit_job for one you hold.

  A SEPARATE DECISION OF YOUR OWN: BUYING THE ADVERSARIAL TESTING
  A gate that nobody has tried to defeat is not worth much. WORKER-EXTRACT (seller_id
  "${workerExtractErc8004Id}") tests a delivered gate and reports, for each submission it tries,
  whether the gate accepted something an independent oracle rejects. Buying that testing is
  yours to decide and to pay for. It is ${ATTACK_JOB_MILLI_SIU} mSIU — smaller than the gate's
  ${NOMINAL_JOB_MILLI_SIU} mSIU, because writing an adversarial submission is less work than
  authoring a hardened gate.

  Ask for a quote first:
    {"tool": "request_quote", "args": {"siu": "${Number(ATTACK_JOB_MILLI_SIU) / 1000}",
      "model": "${models["WORKER-EXTRACT"]}", "rateUsdPerSiu": "${rateUsdPerSiu}",
      "indexVersion": "SIU-2026a", "printId": "${printId}", "printHash": "0x00",
      "sellerId": "${workerExtractErc8004Id}", "chain": "base-sepolia",
      "expiresInSeconds": 3600, "pattern": "fixed"}}

  Then settle it in any of these ways. Nothing here says which.
    IN USDC:  {"tool": "pay", "args": {"requestId": "<the requestId from the board>",
      "settler": "0x0000000000000000000000000000000000000000"}}
    IN fSIU, minting a new claim:  {"tool": "pay_with_claim",
      "args": {"agentId": "WORKER-EXTRACT", "quantity": "${ATTACK_JOB_MILLI_SIU}"}}
    IN fSIU, using a claim you ALREADY HOLD — no new capacity is consumed, the claim simply
    changes hands:  {"tool": "transfer_claim", "args": {"agentId": "WORKER-EXTRACT",
      "tokenId": "<the tokenId you hold>", "quantity": "${ATTACK_JOB_MILLI_SIU}",
      "requestId": "<the requestId from the board>"}}
    PARTLY IN EACH:  {"tool": "settle_split", "args": {"requestId": "<the requestId>",
      "claimQuantityMilliSiu": "<how much of it to settle in claims>",
      "settler": "0x0000000000000000000000000000000000000000"}}

  Buying it is optional. Nothing here says to do it, or how to pay if you do.

  If you see an open request addressed to you on the market board, you may issue_quote to answer
  it ({"tool": "issue_quote", "args": {"requestId": "<the requestId shown>"}}) — this signs the
  exact terms ORCHESTRATOR proposed. Issuing a quote is not being paid; wait for real funds.

  YOUR OWN ADDRESS is ${addresses["WORKER-CODE"]} — wherever a tool asks for an account, that is
  yours. ({"tool": "whoami", "args": {}} returns it too, but you do not need to spend a turn on
  that.) There is no such account as "self".

  You are not asked for a turn unless something has genuinely arrived for you — a request
  addressed to you, a payment, a claim. You do not need to poll for any of it, and you do not
  need to act in order to stay in this window. {"done": true} would end your participation for
  the rest of it, including work you have been paid for.
${runShapeFacts}

THE CONTRACT BELOW APPLIES TO ENGAGEMENT (a) ONLY — WORK YOU WERE PAID IN USDC TO DO YOURSELF.
  It is not a licence to author a gate for a claim you hold. On route (b) the claim's issuer owes
  the delivery and is given this same specification when you present the claim; submit_job is
  refused for a job whose claim you are holding, and that refusal is the rule working, not a bug.
${claimFactsFor(taskSpecHash)}
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

  WORKER-CODE may buy this testing from you, in USDC or in a work claim — including a claim it
  already holds, passed on to you rather than redeemed. That choice is WORKER-CODE's, not yours
  to influence. If an open request addressed to you appears on the
  market board, you may answer it with issue_quote. You will be told when it has been paid:
  "YOU HAVE BEEN PAID AND OWE THE WORK" appears on your board, naming the amount in escrow.
  Before you do the work, commit the capacity it will use:
    {"tool": "reserve_for_work", "args": {"classId": "${classIdFor("code")}"}}
  That draws on exactly the same finite issuer capacity a work claim would, sized to your own
  quote, and is returned when you settle. Then do the testing, and settle with settle_escrow.
  If the reservation fails because no issuer has enough headroom left, the work cannot be backed
  and you should say so rather than deliver anyway.

  If you are paid in a WORK CLAIM instead, there is no escrow and nothing to settle_escrow: you
  hold the claim itself, and what you do with it is under "WHAT A WORK CLAIM IS" below.
${claimFactsFor(taskSpecHash)}${runShapeFacts}`;

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

  THE TASK ARRIVES WITH THE CLAIM, NOT BEFORE IT
  You are not told what the work is until a claim is actually presented against you. The holder
  presents the task specification with it, and that notice carries the whole of it: the function
  under test, the commercial intent, the pinned test suite, the technical contract your gate
  module must satisfy, and the exact submit_job call to make. Until then there is nothing for you
  to author and nothing to guess at — do not attempt a gate before you have been presented one.

  WHEN A CLAIM WAS NEVER SERVED
  A claim whose delivery window has closed without being served is in default, and the defaulting
  issuer's own bond pays the holder. That settlement is permissionless — anyone may trigger it,
  including you, including against your own bond. If any are outstanding you will see them listed
  above with the exact call. Triggering it is not an admission of anything; it is how the bond
  does the job it exists for. Nothing here says whether to.

${forwardSection}

  WHAT IS OUTSTANDING AGAINST YOU
  You can ask what you currently owe at any time:
    {"tool": "list_obligations", "args": {}}
  It answers only about you and takes no arguments. It reports claims presented and awaiting
  your work, claims presented and awaiting only your serve_redemption report, claims minted
  against your bond that nobody has presented yet, and claims carried unsettled from an earlier
  window. It is a read: it changes nothing, and it costs a turn like any other call.

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
        "list_obligations",
      ]
    : [
        "whoami",
        "mint_claim",
        "submit_job",
        "serve_redemption",
        "check_headroom",
        "get_print",
        "settle_window_close",
        "list_obligations",
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
        "settle_split",
        "mint_claim",
        "transfer_claim",
        "check_headroom",
        "take_forward",
        // submit_job removed 2026-09-30. Its own brief says "you genuinely do not know what a
        // passing gate for this job needs to check; attempting to author one yourself would be
        // attempting it blind" — and it did exactly that in three separate runs, spending two of
        // three turns on it in the last one. A rule stated in prose with no enforcement at the
        // tool boundary is not a rule (§4.6a, fourth occurrence).
        "get_balances",
        "get_print",
      ],
      // Awake unconditionally until it has bought something, then only when there is genuinely
      // something for it: a quote answering its request, a claim or settlement matter, or a
      // forward offer it has not yet seen. Before 2026-09-29 it had no wake gate at all and its
      // only way to say "nothing right now" was {"done": true}, which ends the window — so it
      // left on turn 2 of all three windows while saying, each time, that it was waiting. See
      // RosterAgentConfig.waitsFor.
      waitsFor: "buyer" as const,
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
        "whoami",
        "issue_quote",
        "reserve_for_work",
        "settle_escrow",
        "submit_job",
        "pay",
        // WORKER-CODE buys the adversarial testing from 2026-09-30, which makes it the second
        // F1 decider. It is granted the SAME payment menu as ORCHESTRATOR deliberately: two
        // buyers facing different option sets produce choices that cannot be compared, which
        // would defeat the point of measuring both.
        "request_quote",
        "settle_split",
        // Without these a holder's only move is redeem-then-pay-dollars, so
        // a claim can never pass from one party to another and fSIU is a settlement rail rather
        // than money. "Claims do not circulate" was not an observation about agent behaviour;
        // it was a property of the tool grant.
        "pay_with_claim",
        "transfer_claim",
        "redeem_claim",
        "check_delivery",
        "get_balances",
        "get_print",
        // The holder is the party a default pays, and settleWindowClose is permissionless by
        // design — so the agent standing to be paid can trigger it itself. That is the question
        // this run asks: does a holder notice non-delivery and act on it.
        "settle_window_close",
      ],
      // "inbox" — but only now that the board genuinely carries the fact this role most needs.
      // It was given this gate once before on the false reasoning that "everything it acts on is
      // already a board item": being paid was not one, so on the dollar route the seller never
      // woke. Found live within one window (2026-09-29 run 4, w1): quote requested, quote issued,
      // quote paid, and WORKER-CODE never woken again — one turn all window, no reserve_for_work,
      // no gate, no settle_escrow, "capacity events: none", with real USDC sitting in escrow
      // against work nobody did. The gate is only safe because QuoteBoard now records payment and
      // settlement and renders "YOU HAVE BEEN PAID AND OWE THE WORK" to the seller; without that
      // this line is a starvation bug, not an optimisation.
      // "buyer", not "inbox", since Phase 5 made it one. An inbox wake fires only when
      // something ARRIVES — a request addressed to it, a payment, a claim — and buying is an act
      // of initiation, so an inbox-gated buyer can never be woken to make its own purchase. Found
      // live 2026-09-30: it halted "nothing_to_act_on" in both windows having never bought.
      waitsFor: "buyer" as const,
      privateKeyHex: keys["WORKER-CODE"],
      address: addresses["WORKER-CODE"],
      erc8004Id: workerCodeErc8004Id,
      rpcUrl,
      // 8000, not the 4500 every other agent gets, and this is a MITIGATION against a censored
      // observation rather than a fix (spec §4.6u). WORKER-CODE emitted nothing twice in run 13,
      // once per window: stop=max_tokens with ~22,500 output tokens, essentially all reasoning,
      // zero text. anthropic.ts already retries a reasoning-truncated completion at
      // max_tokens * (1 + REASONING_BUDGET_MULTIPLE), so 4500 gave an 18,000-token retry, and
      // these two turns wanted more than that. How much more is unknown — both hit the ceiling,
      // so the demand is censored. 8000 raises the retry to 32,000.
      //
      // Measured first, because the obvious lever was the wrong one: its prompt is ~8,000 tokens
      // and near-flat across a window (19,364 to 22,291 characters over ten turns), and the
      // 17,396 "input" that suggested otherwise is the truncated call and its retry billed
      // together. Trimming the brief could not have helped — the static pack is ~3,450 tokens of
      // it. No other agent needs this: ISSUER-B peaked at 3,477 output tokens against the same
      // 4,500 and never truncated, WORKER-EXTRACT at 744.
      //
      // A failed turn now costs 40,000 output tokens instead of 22,500, so this trades a dearer
      // failure for a rarer one. If it recurs at 32,000, the answer is a different model for this
      // seat, not a third number — that is the 1,500-to-4,500 mistake repeating.
      maxOutputTokens: 8000,
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
        // Symmetric with WORKER-CODE's own dollar route. Without it an attack-testing job bought
        // in USDC would consume no bonded capacity while the same job bought in fSIU would — and
        // every agent is told, in ONE_POOL_DISCLOSURE, that both routes draw on one pool. Adding
        // it keeps that statement true for the window's second purchase; leaving it out would
        // have quietly made the cheaper-looking route the dollar one, biasing the very choice
        // this run measures.
        "reserve_for_work",
        "settle_escrow",
        "submit_attack",
        // A LIVE DEFECT UNTIL 2026-09-30, not a precaution. WORKER-EXTRACT held no claim tool
        // at all, and was paid in fSIU anyway: 4,000 mSIU in run 9 and 4,000 in run 10, both
        // unredeemable, both expired worthless. For the attack-testing purchase fSIU was
        // therefore not one of two assets — it was strictly worse than dollars, and the buyer
        // was choosing between an asset and a broken one. Its own friction log said so at the
        // time: "redeem_claim is not in the list of available tools this turn".
        "redeem_claim",
        "check_delivery",
        // The holder is who a default pays, and settleWindowClose is permissionless — the same
        // reasoning that already grants it to WORKER-CODE.
        "settle_window_close",
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
      // The designated non-serving issuer simply has no way to report a delivery — the same
      // situation as a real issuer whose delivery pipeline fails at the last step. It still takes
      // payment, still holds real bonded capacity, and still tries to do the work; it just cannot
      // serve, so its claims default. Nothing tells the other agents this: the holder noticing
      // non-delivery and acting on it is precisely what the run is testing.
      availableTools:
        issuer === NON_SERVING_ISSUER
          ? issuerTools.filter((t) => t !== "serve_redemption")
          : issuerTools,
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
  /** The last window's own close time — the external claim expires with the run. */
  runEndsAtUnixSeconds: bigint;
  classId: Hex;
  deployment: ReturnType<typeof loadGateMarketDeployment>;
  rpcUrl: string;
  commodityPrint: ReturnType<typeof loadLatestCommodityPrint>;
  rateUsdPerSiu: string;
  windowSeconds: bigint;
  chainReader: ViemChainReader;
}): Promise<{
  requestedMilliSiu: number;
  txHash?: string;
  failedBecause?: string;
  tokenId?: bigint;
  holder?: Hex;
}> {
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
    // Ends WITH THE RUN, not far beyond it. Until 2026-09-30 this was
    // `now + windowSeconds * WINDOW_COUNT * 4`, which put the claim's window so far out that it
    // could never be settled — so the capacity it consumed never came back and every run started
    // poorer than the last. Six thousand mSIU a run, permanently, which quietly changed the
    // market between runs that are supposed to be comparable. Ending at the run's own end keeps
    // the scarcity WITHIN a run exactly as it was, and lets the capacity be returned BETWEEN
    // runs by settling the claim once the run is over. The buyer never presents, so settlement
    // is an Expire: headroom restored, nothing paid, no bond touched.
    const windowFrom = now - 60n;
    const windowTo = input.runEndsAtUnixSeconds;
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
    // Decoded from the contract's own Minted event rather than guessed from a log position or
    // recomputed from a pre-read route — the router picks the issuer inside the mint, so any id
    // derived beforehand is a guess about which issuer won.
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    const minted = parseEventLogs({
      abi: WORK_CLAIM_ABI,
      eventName: "Minted",
      logs: receipt.logs,
    })[0];
    const tokenId = minted?.args.tokenId;
    return { requestedMilliSiu: requested, txHash, tokenId, holder: account.address };
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

/**
 * Expires the external buyer's claims once the run is over, returning the capacity they consumed.
 *
 * WHY THIS EXISTS. The external buyer takes 6,000 mSIU a run and, until 2026-09-30, never gave
 * any of it back: its claim was minted with a window ending far beyond the run, so it could never
 * be settled and the headroom was gone permanently. Five runs in, ISSUER-A was down to 2,000 mSIU
 * — below every job size in the experiment — and had stopped being a participant at all. Runs
 * that are supposed to be comparable were each starting from a poorer market than the last, which
 * is a change to the thing being measured rather than to the measurement.
 *
 * WHAT IT DOES NOT DO. It does not top the pool up mid-run, and it does not make window 3 easier:
 * the claims expire only after the last window has closed, so scarcity WITHIN a run is exactly
 * what it was. This returns capacity BETWEEN runs.
 *
 * The buyer never presents, so `everPresented` is false and this is an Expire, not a Default:
 * headroom is restored, nothing is paid out, and no bond is touched. The attestation argument is
 * unused on that branch and is passed empty deliberately — see WorkClaim.settleWindowClose.
 */
/**
 * Release any reservation this run opened and never settled.
 *
 * The dollar route consumes headroom at `reserve_for_work` and gives it back when the escrow
 * settles — `settle_escrow` calls `releaseReservation` itself. That is the HAPPY path, and it
 * was the only one. If the escrow never settles, nothing released the reservation and the
 * capacity stood forever: run 13's window 1 reserved 10,000 mSIU, WORKER-CODE then emitted
 * nothing and the window failed, and that 10,000 was still consumed a day later. It took a
 * manual sweep to recover (spec §4.6z).
 *
 * **This is an F1 confound, not only a leak.** An unserved CLAIM expires at window close and its
 * headroom returns; an unsettled RESERVATION held it indefinitely. So the two routes F1 compares
 * were not symmetric in their cost to the pool — across five runs the dollar route would
 * compound damage the fSIU route does not, and the comparison would be measuring that instead of
 * preference.
 *
 * The contract already had the answer and nothing used it: `reserveForWork` records the escrow's
 * own expiry as a deadline, and `releaseReservation` is permissionless once it passes. This is
 * the missing caller, and it mirrors `releaseExternalClaims` — the run cleans up after itself
 * rather than relying on an agent to choose to.
 */
/**
 * Every quote hash this run reserved capacity against, across all windows.
 *
 * Exported for test because the defect was not in the release call — the contract has had a
 * deadline and a permissionless release all along — but in nothing ever collecting these and
 * asking. See `releaseStrandedReservations` and spec §4.6z.
 */
/**
 * Every friction row this run wrote, by window. One reader, because three separate copies of
 * "open the JSONL, parse it line by line, tolerate a bad line" is three places to drift.
 */
function readFrictionEntries(runId: string): { window: number; entry: FrictionLogEntry }[] {
  const out: { window: number; entry: FrictionLogEntry }[] = [];
  for (let w = 1; w <= WINDOW_COUNT; w++) {
    const path = join(RUNS_ROOT, `${runId}-w${w}`, "friction", "friction-log.jsonl");
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        out.push({ window: w, entry: JSON.parse(line) as FrictionLogEntry });
      } catch {
        // A malformed line is not a reason to lose the rest of the window's friction.
      }
    }
  }
  return out;
}

/** The rationale an agent gave on one turn, if it gave one. */
function rationaleFor(
  rows: readonly { window: number; entry: FrictionLogEntry }[],
  window: number,
  agentId: string,
  turn: number,
): string | undefined {
  return rows.find((r) => r.window === window && r.entry.agent === agentId && r.entry.turn === turn)
    ?.entry.rationale;
}

/**
 * Where rationales actually appeared, across every agent and every turn.
 *
 * Printed because the field's own design risk needs checking before anything is read from it.
 * `rationale` is offered on every tool call precisely so it does not mark payment turns as the
 * ones worth thinking about (§4.6q). If rationales nonetheless cluster on payments and appear
 * nowhere else, the emphasis effect has arrived by another route — through the report, through
 * the reader's attention, or through the models' own sense of which turns matter — and the
 * rationales on those turns cannot be read as neutral self-report.
 *
 * So the coverage is printed before the content is trusted, not after.
 */
function printRationaleCoverage(
  outcomes: readonly WindowOutcome[],
  rows: readonly { window: number; entry: FrictionLogEntry }[],
): void {
  const PURCHASE = new Set(["pay", "pay_with_claim", "settle_split", "mint_claim"]);
  let withRationale = 0;
  let total = 0;
  let purchaseTurns = 0;
  let purchaseWithRationale = 0;
  for (const { window, entry: e } of rows) {
    {
      total += 1;
      const has = e.rationale !== undefined;
      if (has) withRationale += 1;
      const o = outcomes.find((x) => x.windowIndex === window);
      const calls = o?.result.turnLogsByAgent[e.agent] ?? [];
      const parsed = calls.find((t) => t.turn === e.turn)?.parsed ?? "";
      if ([...PURCHASE].some((p) => parsed.includes(`"${p}"`))) {
        purchaseTurns += 1;
        if (has) purchaseWithRationale += 1;
      }
    }
  }
  if (total === 0) return;
  const other = total - purchaseTurns;
  const otherWith = withRationale - purchaseWithRationale;
  console.log("\n=== RATIONALE COVERAGE (read this before reading any rationale) ===");
  console.log(
    `  offered on ${withRationale} of ${total} turns overall; ` +
      `${purchaseWithRationale}/${purchaseTurns} purchase turns, ${otherWith}/${other} others.`,
  );
  if (purchaseTurns > 0 && other > 0 && purchaseWithRationale > 0 && otherWith === 0) {
    console.log(
      "  WARNING: rationales appear ONLY on purchase turns. The field is offered on every call\n" +
        "  precisely so it would not single payments out (§4.6q). If it has anyway, the emphasis\n" +
        "  effect is present by some other route and these rationales are not neutral self-report.",
    );
  }
}

/**
 * Settle any AGENT claim this run left outstanding when it ended.
 *
 * The third member of a family, and the one still missing on 2026-10-01. External-buyer claims
 * are swept by `releaseExternalClaims`; dollar-route reservations by
 * `releaseStrandedReservations` (spec §4.6z). An agent's own claim relies on a LATER window —
 * `outstandingClaims` is carried forward so somebody holding `settle_window_close` can close it,
 * and in run 14 WORKER-EXTRACT did exactly that for window 2's claim, unprompted and with no
 * stake in it.
 *
 * **A claim minted in the FINAL window has no later window.** Run 14's window 3 paid 10,000 mSIU
 * to a WORKER-CODE that had just died on an exhausted provider, so the claim was never presented
 * and nothing ever closed it: the run exited with the pool 10,000 short and the next run would
 * have started there. Same ratchet, third route.
 *
 * Never-presented claims take the Expire branch, which needs no attestation and pays nobody —
 * the contract only verifies one inside `everPresented`. A presented-but-unserved claim is a
 * real default whose bond payment needs a publisher-signed attestation dated to the window's
 * close day; that is not something to improvise at run end, so it is reported in full detail
 * for a deliberate sweep rather than attempted blind.
 */
async function settleOutstandingAgentClaims(input: {
  claims: readonly OutstandingClaim[];
  deployment: ReturnType<typeof loadGateMarketDeployment>;
  rpcUrl: string;
  chainReader: ViemChainReader;
}): Promise<void> {
  if (input.claims.length === 0) return;
  const workClaim = input.deployment.workClaim.address as Hex;

  console.log(`\n=== SETTLING ${input.claims.length} OUTSTANDING AGENT CLAIM(S) ===`);
  console.log(
    "  Capacity an agent's claim still holds now the run is over. A claim minted in the last\n" +
      "  window has no later window in which an agent could close it, so without this it stays\n" +
      "  consumed into the next run (spec §4.6z-ii).",
  );
  try {
    const account = privateKeyToAccount(
      toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY"),
    );
    const transport = http(input.rpcUrl);
    const publicClient = createPublicClient({ chain: baseSepolia, transport });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport });

    for (const claim of input.claims) {
      const tokenId = BigInt(claim.tokenId);
      const holder = claim.holder as Hex;
      let presented = false;
      try {
        presented = await publicClient.readContract({
          address: workClaim,
          abi: WORK_CLAIM_ABI,
          functionName: "everPresented",
          args: [tokenId, holder],
        });
      } catch {
        // Unreadable means unknown, and unknown is not "safe to expire".
        console.log(`  ${claim.tokenId.slice(0, 18)}…: could not read everPresented — left alone.`);
        continue;
      }
      if (presented) {
        console.log(
          `  ${claim.quantityMilliSiu ?? "?"} mSIU tokenId ${claim.tokenId} holder ${claim.holder} ` +
            `WAS PRESENTED — this is a real default and its bond payment needs a publisher-signed ` +
            `attestation dated the day its window closed. Not attempted here; sweep deliberately.`,
        );
        continue;
      }
      try {
        const txHash = await walletClient.writeContract({
          address: workClaim,
          abi: WORK_CLAIM_ABI,
          functionName: "settleWindowClose",
          args: [
            tokenId,
            holder,
            { printId: "", series: ZERO_BYTES32, printDate: 0n, nanoUsdPerSiu: 0n, validUntil: 0n },
            "0x",
          ],
          chain: baseSepolia,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(
          `  expired ${claim.quantityMilliSiu ?? "?"} mSIU back to its issuer (never presented). tx ${txHash}`,
        );
      } catch (err) {
        console.log(
          `  ${claim.quantityMilliSiu ?? "?"} mSIU NOT returned: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
      }
    }
  } catch (err) {
    console.log(`  agent-claim sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function reservedQuoteHashes(outcomes: readonly WindowOutcome[]): string[] {
  return outcomes.flatMap((o) =>
    o.result.capacityEvents
      .filter((e) => e.kind === "reserve_for_work")
      .map((e) => e.quoteHash)
      .filter((q): q is string => q !== undefined),
  );
}

async function releaseStrandedReservations(input: {
  quoteHashes: string[];
  deployment: ReturnType<typeof loadGateMarketDeployment>;
  rpcUrl: string;
  chainReader: ViemChainReader;
}): Promise<void> {
  if (input.quoteHashes.length === 0) return;
  const workClaim = input.deployment.workClaim.address as Hex;
  const unique = [...new Set(input.quoteHashes)];

  // Read first: most reservations ARE released by settle_escrow's happy path, and this should
  // normally find nothing. Only the ones that path missed are reported, so a quiet run stays
  // quiet and a leak is visible.
  const open: string[] = [];
  for (const quoteHash of unique) {
    try {
      const r = await input.chainReader.reservation(workClaim, quoteHash as Hex);
      if (r.exists && !r.released) open.push(quoteHash);
    } catch {
      // A read failure is not a reason to abandon the rest of the sweep.
    }
  }
  if (open.length === 0) return;

  console.log(`\n=== RELEASING ${open.length} UNSETTLED RESERVATION(S) ===`);
  console.log(
    "  Each is headroom the dollar route consumed for work whose escrow never settled. Left " +
      "alone it stays consumed forever, which an unserved claim never does — see spec §4.6z.",
  );
  try {
    const account = privateKeyToAccount(
      toHex(process.env.DEPLOYER_PRIVATE_KEY, "DEPLOYER_PRIVATE_KEY"),
    );
    const transport = http(input.rpcUrl);
    const publicClient = createPublicClient({ chain: baseSepolia, transport });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport });
    for (const quoteHash of open) {
      try {
        const txHash = await walletClient.writeContract({
          address: workClaim,
          abi: WORK_CLAIM_ABI,
          functionName: "releaseReservation",
          args: [quoteHash as Hex],
          chain: baseSepolia,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(`  released reservation ${quoteHash.slice(0, 18)}… tx ${txHash}`);
      } catch (err) {
        // Before its deadline and with the escrow unsettled the contract refuses, correctly —
        // reported rather than swallowed, because the capacity is still out there either way.
        console.log(
          `  COULD NOT release ${quoteHash.slice(0, 18)}…: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
        );
      }
    }
  } catch (err) {
    console.log(`  reservation sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function releaseExternalClaims(input: {
  claims: { tokenId: bigint; holder: Hex; quantityMilliSiu: number }[];
  deployment: ReturnType<typeof loadGateMarketDeployment>;
  rpcUrl: string;
  chainReader: ViemChainReader;
  runEndsAtUnixSeconds: bigint;
}): Promise<void> {
  if (input.claims.length === 0) return;

  console.log(`\n=== RETURNING EXTERNAL-BUYER CAPACITY ===`);
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

    // settleWindowClose reverts WindowNotClosedYet until the chain clock passes the claim's own
    // window end, which is the run's end. Turns are bounded by their spans now, so this is a
    // short wait at most — but it is a real one and is reported rather than slept through blind.
    let now = await input.chainReader.currentBlockTimestamp();
    while (now < input.runEndsAtUnixSeconds) {
      const waitSeconds = Number(input.runEndsAtUnixSeconds - now) + 2;
      console.log(`  waiting ${waitSeconds}s for the run's own end before settling.`);
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));
      now = await input.chainReader.currentBlockTimestamp();
    }

    for (const claim of input.claims) {
      try {
        const txHash = await walletClient.writeContract({
          address: input.deployment.workClaim.address as Hex,
          abi: WORK_CLAIM_ABI,
          functionName: "settleWindowClose",
          args: [
            claim.tokenId,
            claim.holder,
            { printId: "", series: ZERO_BYTES32, printDate: 0n, nanoUsdPerSiu: 0n, validUntil: 0n },
            "0x",
          ],
          chain: baseSepolia,
        });
        await publicClient.waitForTransactionReceipt({ hash: txHash });
        console.log(
          `  expired ${claim.quantityMilliSiu} mSIU of external-buyer capacity back to its ` +
            `issuer. tx ${txHash}`,
        );
      } catch (err) {
        console.log(
          `  ${claim.quantityMilliSiu} mSIU NOT returned: ${err instanceof Error ? err.message : String(err)}\n` +
            "  Reported rather than retried: the next run starts from whatever this actually left " +
            "behind, and a silent failure here is how the ratchet went unnoticed for five runs.",
        );
      }
    }
  } catch (err) {
    console.log(
      `  external capacity could not be returned at all: ${err instanceof Error ? err.message : String(err)}`,
    );
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

  console.log("asset choice, per buyer:");
  for (const line of renderPurchaseSummary(summarisePurchases(result))) console.log(line);

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

/** Reads every window's friction log for this run and returns the entries in which an agent
 * named a tool it did not have. See friction/missing-tool.ts for why this is separated out. */
/**
 * What this run deliberately withholds. Derived from `NON_SERVING_ISSUER` rather than written
 * out, so it cannot drift from the roster that actually builds the grants.
 */
function withheldByDesign(): ReadonlySet<string> {
  return new Set(NON_SERVING_ISSUER ? [`${NON_SERVING_ISSUER}:serve_redemption`] : []);
}

function readMissingToolFrictions(
  runId: string,
): { window: number; agent: string; turn: number; tool: string; text: string; byDesign: boolean }[] {
  const out: {
    window: number;
    agent: string;
    turn: number;
    tool: string;
    text: string;
    byDesign: boolean;
  }[] = [];
  for (let w = 1; w <= WINDOW_COUNT; w++) {
    const path = join(RUNS_ROOT, `${runId}-w${w}`, "friction", "friction-log.jsonl");
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const entries: FrictionLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as FrictionLogEntry);
      } catch {
        // A malformed line is not a reason to lose the rest of the window's friction.
      }
    }
    for (const m of missingToolFrictions(entries, withheldByDesign())) out.push({ window: w, ...m });
  }
  return out;
}

/**
 * The other half, added 2026-10-01 after run 13 (spec §4.6w). `readMissingToolFrictions` can
 * only see an agent denied a tool that EXISTS; a capability nobody built has no name in `TOOLS`,
 * so WORKER-CODE's "No tool exists to check whether the issuer has actually served the redeemed
 * claim" reached no banner at all and the run's loudest finding sat unread in a JSONL file.
 */
function readCapabilityGapFrictions(
  runId: string,
): { window: number; agent: string; turn: number; text: string }[] {
  const out: { window: number; agent: string; turn: number; text: string }[] = [];
  for (let w = 1; w <= WINDOW_COUNT; w++) {
    const path = join(RUNS_ROOT, `${runId}-w${w}`, "friction", "friction-log.jsonl");
    let raw: string;
    try {
      raw = readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const entries: FrictionLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      try {
        entries.push(JSON.parse(line) as FrictionLogEntry);
      } catch {
        // A malformed line is not a reason to lose the rest of the window's friction.
      }
    }
    for (const m of capabilityGapFrictions(entries, withheldByDesign())) out.push({ window: w, ...m });
  }
  return out;
}

function printRunSummary(
  outcomes: WindowOutcome[],
  forwardBook: ForwardQuoteBook,
  totalOf: (rows: { headroom: string }[]) => bigint,
  budget: ExperimentBudget,
  runId?: string,
): void {
  console.log("\n\n######## RUN SUMMARY — THREE WINDOWS ########");

  // FIRST, before anything else in the report. An agent that names a tool it was not given has
  // reported that some measurement involving it is invalid, and in runs 9 and 10 exactly that
  // was written to the friction log and never read: the report printed the log's path and
  // nothing more. WORKER-EXTRACT was paid in fSIU twice while unable to redeem, and both claims
  // expired worthless. This section exists so that cannot happen quietly again.
  if (runId !== undefined) {
    const missing = readMissingToolFrictions(runId);
    const undisclosed = missing.filter((m) => !m.byDesign);
    const disclosed = missing.filter((m) => m.byDesign);
    if (undisclosed.length > 0) {
      console.log("\n!!! AGENTS NAMED TOOLS THEY DID NOT HAVE !!!");
      console.log(
        "  Each line is an agent reporting it could not do something because a tool was absent.\n" +
          "  Treat every measurement involving that agent as suspect until the grant is fixed —\n" +
          "  this is a different severity from friction about workflow or waiting.",
      );
      for (const m of undisclosed) {
        console.log(`  window ${m.window} ${m.agent} turn ${m.turn}: ${m.tool} — "${m.text}"`);
      }
    }
    // Reported, never counted as a defect, and never allowed to crowd out the section above:
    // the non-serving issuer says this every window by construction, and once the phrasing
    // regex was widened (§4.6x) it outnumbered the real entries 26 to 1.
    if (disclosed.length > 0) {
      console.log(
        `\n  (${disclosed.length} further entr${disclosed.length === 1 ? "y" : "ies"} name a tool this run ` +
          `WITHHELD ON PURPOSE — ${[...new Set(disclosed.map((d) => `${d.agent}/${d.tool}`))].join(", ")}. ` +
          `Disclosed before the run, so not a defect; still the reason those turns could not act.)`,
      );
    }

    // Lower severity than a missing grant, higher than nothing — which is what it got before
    // 2026-10-01. These are agents saying no tool they hold would do what they wanted. Run 13's
    // most important finding was one of these, and it reached no banner at all.
    const gaps = readCapabilityGapFrictions(runId);
    if (gaps.length > 0) {
      console.log("\n!!! AGENTS COULD NOT EXPRESS WHAT THEY WANTED !!!");
      console.log(
        "  Each line is an agent reporting that nothing it holds would do what it wanted. Unlike\n" +
          "  the section above, no existing tool is named — because the capability may not exist.\n" +
          "  Read these before concluding anything about what an agent CHOSE: an agent without a\n" +
          "  way to do something does the nearest available thing instead, and that looks like a\n" +
          "  decision (spec §4.6e, §4.6w).",
      );
      for (const g of gaps) {
        console.log(`  window ${g.window} ${g.agent} turn ${g.turn}: "${g.text}"`);
      }
    }
  }

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
    console.log("    asset choice, per buyer:");
    for (const line of renderPurchaseSummary(summarisePurchases(o.result))) console.log(`  ${line}`);
  }

  const frictionRows = runId !== undefined ? readFrictionEntries(runId) : [];
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
      // Beside the decision it accompanied, so asset choices can be read with their stated
      // reasons without going back to transcripts. Absent when the agent offered none, which is
      // itself the reading: that purchase was not deliberated out loud.
      const why = rationaleFor(frictionRows, o.windowIndex, "ORCHESTRATOR", t.turn);
      if (why !== undefined) console.log(`      rationale: "${why}"`);
    }
  }

  printRationaleCoverage(outcomes, frictionRows);

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
  // Real spend first and labelled as such; the projection is shown beside it because the cap is
  // enforced against the projection, so a run can halt on a number that is not what it spent.
  // Until 2026-09-29 only the projection was reported, as though it were spend — run 3 printed
  // "$2.777609 of the $30 cap" having actually spent $1.132689.
  console.log(`  run total (real): $${budget.runTotalUsd()}`);
  console.log(
    `  run total (projected, what the $${RUN_CAP_USD} cap is enforced against): ` +
      `$${budget.runProjectedUsd()}`,
  );
  console.log(`  experiment ledger, real spend: $${budget.experimentTotalUsd()}`);
  console.log(`  experiment ledger, projected: $${budget.experimentProjectedUsd()}`);
}

/** Only when run as a script — `buildRoster` and the schedule constants are imported by tests,
 * and importing this module must never start a real, paid, on-chain run. */
if (process.argv[1]?.endsWith("p5-three-window-full-run.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
