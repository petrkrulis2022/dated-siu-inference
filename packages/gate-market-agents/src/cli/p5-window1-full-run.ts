import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import { createAdapterFor, loadApiKeysFromEnv, withBackoff, type Adapter } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import {
  CODE_GATE_1_TRIVIAL,
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_COMMERCIAL_INTENT,
  CODE_HELD_OUT_INSTANCES,
  PINNED_TEST_SUITE,
  runGateHardeningChecks,
} from "@touchstone/task-pack-gate-hardening";
import type { HeldOutInstance, ReferenceTaskInstance } from "@touchstone/task-pack-gate-hardening";
import { loadSkill, renderTemplate } from "../skills/registry.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import type { ModelPrices } from "../budget/inference-cost.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { validateModelAssignment, type ModelAssignments } from "../pack/model-assignment.js";
import { erc8004IdFor } from "../identity/resolve.js";
import type { RunnerDeps } from "../deps.js";
import { loadGateMarketDeployment } from "../chain/deployment.js";
import { ViemChainReader } from "../chain/reader.js";
import { runFullRunWindow, type JobEnvelope, type MintContext, type RosterAgentConfig } from "../loop/full-run.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";

/**
 * WP-7's real P5 window 1: the user's own instruction (2026-09-26) — "the question you're really
 * asking in P5 is whether agents use a work claim when they have the choice. That only has an
 * answer if the orchestrator genuinely needs to buy work." ORCHESTRATOR is reassigned to
 * mistral-small-3.2-24b-instruct (empirically verified unable to solo this job — see
 * data/gate-market/runs/orchestrator-weak-model-probe-2026-09-26T06-09-01-674Z/ and
 * data/deployments/base-sepolia-gate-market.json's own orchestratorReassignment record), so any
 * delegation this window is emergent, not scripted — the deciding-agent family separation
 * (spec §12.2a) still holds after the reassignment (re-validated below, real registry, real
 * assignment).
 *
 * Roster: ORCHESTRATOR, WORKER-CODE, WORKER-EXTRACT, ISSUER-A, ISSUER-B — five of the six. HEDGER
 * is deliberately excluded: its own 10-job flat-price stream is a separate concern from the
 * delegation/asset-choice question this window answers, and folding it in would need its own
 * parallel job queue (real scope, not needed here) — disclosed in the run's own console output
 * and in the eventual report, not silently dropped.
 *
 * One real job — the same pinned `code`-class task P4 already proved (dedupeSorted, the same
 * pinned test suite), not a fresh, unvalidated one for this first real multi-agent run.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const LEDGER_PATH = join(REPO_ROOT, "data/gate-market/experiment-ledger.json");

const RUN_CAP_USD = "30";
const EXPERIMENT_CAP_USD = "150";

// Real, current registry prices (data/registry/price-snapshot-merged-2026-09-25T00-59-34.865Z.json,
// the latest snapshot at the time this script was written) — never invented.
const PRICES: Record<string, ModelPrices> = {
  "mistral-small-3.2-24b-instruct": { priceInUsdPer1M: "0.09", priceOutUsdPer1M: "0.3" },
  "claude-sonnet-5": { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" },
  "gemini-3.1-pro-preview": { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" },
  "grok-4.6": { priceInUsdPer1M: "2", priceOutUsdPer1M: "6" },
};

// The one illustrative rate this window's real mint_claim/get_print calls attest to and read —
// $0.01/SIU, the same illustrative figure the dry loop's own DRY_LOOP_NANO_USD_PER_SIU already
// established (packages/gate-market-agents/src/dry-loop/context.ts) — not derived from any real
// Dated SIU print (the Gate Market fSIU testbed is explicitly outside the real print pipeline,
// per CLAUDE.md's own sanctioned exception).
const ILLUSTRATIVE_NANO_USD_PER_SIU = 10_000_000n;
const ILLUSTRATIVE_RATE_USD_PER_SIU = "0.01";
const ILLUSTRATIVE_PRINT_ID = "p5-window1-illustrative";

function withPinnedTestSuite(instance: ReferenceTaskInstance): ReferenceTaskInstance {
  return { ...instance, files: { ...instance.files, "pinned-test-cases.txt": PINNED_TEST_SUITE } };
}
function withPinnedTestSuiteHeldOut(held: HeldOutInstance): HeldOutInstance {
  return { ...held, referenceInstance: withPinnedTestSuite(held.referenceInstance) };
}

function toHex(raw: string | undefined, name: string): Hex {
  if (!raw) throw new Error(`${name} is not set.`);
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

/** `runFullRunWindow` calls each agent's adapter directly, unwrapped — fine for a single request,
 * but this is a real, multi-turn, multi-provider live run, and OpenRouter's shared free-tier
 * provider pools are confirmed (packages/agents/src/cli/demo.ts's own comment, hit live) to 429
 * intermittently under load with no other change; hit live here too, on this run's very first
 * real ORCHESTRATOR call. `withBackoff` (@touchstone/harness) already exists for exactly this —
 * `seller.ts` already wraps its own adapter call with it — just applied here at construction so
 * every agent's calls this window get the same real retry behaviour. */
function withRetry(adapter: Adapter): Adapter {
  return (model, prompt, params) => withBackoff(() => adapter(model, prompt, params));
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8"));
  const deploymentRecord = JSON.parse(
    readFileSync(join(REPO_ROOT, "data/deployments/base-sepolia-gate-market.json"), "utf-8"),
  );
  const modelAssignment: ModelAssignments = deploymentRecord.roster.modelAssignment;

  // Real model-assignment validation (spec §12.2a) — refuses to start on a violation, including
  // after today's ORCHESTRATOR reassignment.
  validateModelAssignment(modelAssignment, registry);
  console.log("Model assignment validated (spec §12.2a): OK — deciding-agent family separation holds after the ORCHESTRATOR reassignment.\n");

  const deployment = loadGateMarketDeployment();
  const apiKeys = loadApiKeysFromEnv();

  const registryEntry = (id: string): { provider: string; host: string } => {
    const entry = registry.find((r: { id: string }) => r.id === id);
    if (!entry) throw new Error(`"${id}" is not a registered model.`);
    return { provider: entry.provider, host: entry.host };
  };

  const orchestratorModel = modelAssignment.ORCHESTRATOR.reasoningModel;
  const workerCodeModel = modelAssignment["WORKER-CODE"].reasoningModel;
  const workerExtractModel = modelAssignment["WORKER-EXTRACT"].reasoningModel;
  const issuerAModel = modelAssignment["ISSUER-A"].reasoningModel;
  const issuerBModel = modelAssignment["ISSUER-B"].reasoningModel;

  const orchestratorAdapter = withRetry(createAdapterFor(registryEntry(orchestratorModel), apiKeys));
  const workerCodeAdapter = withRetry(createAdapterFor(registryEntry(workerCodeModel), apiKeys));
  const workerExtractAdapter = withRetry(createAdapterFor(registryEntry(workerExtractModel), apiKeys));
  const issuerAAdapter = withRetry(createAdapterFor(registryEntry(issuerAModel), apiKeys));
  const issuerBAdapter = withRetry(createAdapterFor(registryEntry(issuerBModel), apiKeys));

  const referenceInstance = withPinnedTestSuite(CODE_REFERENCE);
  const heldOutInstances = CODE_HELD_OUT_INSTANCES.map(withPinnedTestSuiteHeldOut) as [
    HeldOutInstance,
    ...HeldOutInstance[],
  ];

  const job: JobEnvelope = {
    jobId: "p5-window1-job",
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

  const workerCodeAddress = process.env.WORKER_CODE_ADDRESS ?? "";
  const workerCodeErc8004Id = erc8004IdFor(workerCodeAddress);

  const technicalContract = `
THE FUNCTION UNDER TEST: a submission provides a named export \`dedupeSorted(arr)\` from a file
  called answer.mjs. It must remove consecutive duplicate values from a sorted array of numbers,
  preserving order.

COMMERCIAL INTENT:
  ${CODE_COMMERCIAL_INTENT}

THE PINNED TEST SUITE (the real, operator-authored test cases your gate must run — reproduced
here exactly, and also available to your gate at runtime as data):
---
${PINNED_TEST_SUITE}---
  Each line above is a real node:test case body. It assumes \`test\` (from "node:test"), \`assert\`
  (from "node:assert/strict") and \`dedupeSorted\` (the submission's own export) are already
  imported and in scope wherever it runs.

HOW A GATE IS AUTHORED (technical contract, not a solution):
  Your gate's source is a JavaScript ES module. It must export:
    export async function gate({ referenceDir, submissionDir }) {
      // referenceDir + "/pinned-test-cases.txt" holds the exact test-case bodies shown above.
      // submissionDir + "/answer.mjs" is the submission being graded.
      // Genuinely execute the pinned cases against THIS submission's own dedupeSorted every time.
      // Return { accept: <boolean>, reason: <string> }.
    }
  It runs inside a sandbox with node:fs and node:child_process available (spawning the node
  binary itself, at process.execPath, is allowed) — no network, no other imports beyond node
  builtins. Any file your gate needs to write must be written under referenceDir.

TO SUBMIT A GATE, respond with exactly:
  {"tool": "submit_job", "args": {"source": "<your full gate module source as a JSON string>"}}
  If it does not pass every check, you will see exactly which check failed and why on your next
  turn — revise and resubmit within your turn budget.
`;

  const orchestratorJobDescription = `
YOUR JOB THIS WINDOW
  You have been given a gate-hardening job for the "code" class (see the technical contract
  below). You are paid only if a passing gate is delivered before your turns or budget run out.
  You have three real, genuinely different ways to get it delivered — pick whichever you judge
  best; nothing here tells you which to prefer:

  OPTION 1 — do it yourself: author the gate directly and call submit_job (format at the bottom).

  OPTION 2 — subcontract for USDC: request a quote from WORKER-CODE (seller_id
  "${workerCodeErc8004Id}"), then pay the real quote it issues, then wait for it to deliver.
    Step 1: {"tool": "request_quote", "args": {"siu": "10", "model": "${workerCodeModel}",
      "rateUsdPerSiu": "${ILLUSTRATIVE_RATE_USD_PER_SIU}", "indexVersion": "SIU-2026a",
      "printId": "${ILLUSTRATIVE_PRINT_ID}", "printHash": "0x00", "sellerId": "${workerCodeErc8004Id}",
      "chain": "base-sepolia", "expiresInSeconds": 3600, "pattern": "fixed"}}
    Step 2 (once WORKER-CODE has issued a quote — you will see it on the market board below):
      {"tool": "pay", "args": {"requestId": "<the requestId from the board>",
      "settler": "0x0000000000000000000000000000000000000000"}}
    Step 3: wait (respond {"done": true, ...} only once you're sure nothing more is needed from
      you, or keep checking back — WORKER-CODE will call submit_job itself once paid and ready).

  OPTION 3 — subcontract for fSIU (a dated work claim, not a dollar): mint a claim, then transfer
  it to WORKER-CODE as payment.
    Step 1: {"tool": "mint_claim", "args": {"quantity": "10000"}}
      (quantity is in milli-SIU; 10000 = 10 SIU, matching Option 2's own quote size)
    Step 2 (once mint_claim returns a tokenId):
      {"tool": "transfer_claim", "args": {"agentId": "WORKER-CODE", "tokenId": "<the tokenId
      mint_claim returned>", "quantity": "10000"}}
    Step 3: wait, same as Option 2's step 3.

  Whichever you choose, you may check get_balances()/get_print() at any time. If you genuinely
  have nothing further to do (waiting on a subcontractor, or the job is already delivered),
  respond with {"done": true, "summary": "<why>"} rather than repeating a call with nothing new.
${technicalContract}`;

  const workerCodeJobDescription = `
YOUR SITUATION THIS WINDOW
  ORCHESTRATOR has a gate-hardening job for the "code" class (technical contract below) and may
  either do it alone or subcontract it to you, in USDC or in a work claim (fSIU) — that choice is
  genuinely ORCHESTRATOR's, not yours to influence, and not yours to pre-empt.

  DO NOT author or submit_job this gate unless you have genuinely been engaged for it — meaning
  at least one of: (a) you have been paid (a quote you issued was paid against — check
  get_balances to confirm real funds actually arrived), or (b) you hold a real work claim
  ORCHESTRATOR transferred to you (again, check get_balances). Doing the work before either of
  these has genuinely happened would not be answering ORCHESTRATOR's request, it would be
  bypassing it — do not do this even if you are confident you could deliver a passing gate.

  If you see an open request addressed to you on the market board, you may issue_quote to answer
  it (format: {"tool": "issue_quote", "args": {"requestId": "<the requestId shown>"}}) — this
  signs the exact terms ORCHESTRATOR proposed, it does not let you set your own price. Issuing a
  quote is not itself being paid — wait for real funds or a real transferred claim before
  delivering.

  If there is nothing here for you to do yet (no open request, no payment received, no claim
  held), DO NOT respond with {"done": true} — that would permanently end your own participation
  in this window and you would miss a real request or payment that arrives later. Instead, check
  again with a real, harmless read: {"tool": "get_balances", "args": {"account":
  "${workerCodeAddress}"}} (that is your own real address). Only respond {"done": true} once the
  job has genuinely already been delivered and settled and there is truly nothing further anyone
  could need from you.
${technicalContract}`;

  const workerExtractJobDescription = `
YOUR SITUATION THIS WINDOW
  There is no "extract"-class job in this window — only a "code"-class job assigned to
  ORCHESTRATOR/WORKER-CODE. You are included in this run's roster for its own model-assignment
  record, not because there is work for you here. If nothing on the market board is addressed to
  you, respond immediately with {"done": true, "summary": "no extract-class work this window"}
  rather than guessing at an action.
`;

  const issuerJobDescription = `
YOUR SITUATION THIS WINDOW
  A buyer may mint a "code"-class claim against your bonded capacity (ClaimRouter routes to
  whichever issuer has headroom — you may not be the one routed to, and that may not happen on
  your very first turn). If a claim mints against you, a holder will eventually present it for
  redemption and someone will submit_job to grade the underlying work; once that is done you will
  see "PENDING REDEMPTION ROUTED TO YOU" below with every real field serve_redemption needs. Call
  serve_redemption with exactly those values once you see it.

  Otherwise, if you have nothing to do yet, DO NOT respond with {"done": true} — that would
  permanently end your own participation in this window and you would miss a real redemption
  routed to you later. Instead, check again with a real, harmless read:
  {"tool": "get_print", "args": {"printId": "${ILLUSTRATIVE_PRINT_ID}"}}. Only respond
  {"done": true} once you are certain nothing further could ever be routed to you this window.
`;

  const orchestratorAddress = toHex(process.env.ORCHESTRATOR_ADDRESS, "ORCHESTRATOR_ADDRESS");
  const workerCodeAddressHex = toHex(process.env.WORKER_CODE_ADDRESS, "WORKER_CODE_ADDRESS");
  const workerExtractAddress = toHex(process.env.WORKER_EXTRACT_ADDRESS, "WORKER_EXTRACT_ADDRESS");
  const issuerAAddress = toHex(process.env.ISSUER_A_ADDRESS, "ISSUER_A_ADDRESS");
  const issuerBAddress = toHex(process.env.ISSUER_B_ADDRESS, "ISSUER_B_ADDRESS");

  const capacityLots = deploymentRecord.capacityLots;
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL ?? "";
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const windowFrom = nowSeconds - 60n;
  const windowTo = nowSeconds + 3600n; // one real, compressed hour-long window for this run

  const issueWorkClaimsSkill = loadSkill("issue-work-claims");
  const issuerSkillPackText = (issuer: "ISSUER-A" | "ISSUER-B"): string => {
    const lot = capacityLots[issuer];
    const rendered = renderTemplate(issueWorkClaimsSkill.promptTemplate, {
      class: "code",
      measured_rate: (lot.measuredRateMilliSiuPerHour / 1000).toString(),
      committed_hours: lot.committedCapacityHours.toString(),
      from: new Date(Number(windowFrom) * 1000).toISOString().slice(0, 10),
      until: new Date(Number(windowTo) * 1000).toISOString().slice(0, 10),
      amount: (lot.bondedUsdcPerClass / 1_000_000).toString(),
    });
    return `${rendered}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${issuerJobDescription}`;
  };

  const roster: RosterAgentConfig[] = [
    {
      agentId: "ORCHESTRATOR",
      adapter: orchestratorAdapter,
      modelString: orchestratorModel,
      prices: PRICES[orchestratorModel],
      skillPackText: `${loadSkill("subcontract-and-settle").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${orchestratorJobDescription}`,
      availableTools: ["request_quote", "pay", "mint_claim", "transfer_claim", "check_headroom", "submit_job", "get_balances", "get_print"],
      privateKeyHex: toHex(process.env.ORCHESTRATOR_PRIVATE_KEY, "ORCHESTRATOR_PRIVATE_KEY"),
      address: orchestratorAddress,
      erc8004Id: erc8004IdFor(orchestratorAddress),
      rpcUrl,
      maxOutputTokens: 3000,
    },
    {
      agentId: "WORKER-CODE",
      adapter: workerCodeAdapter,
      modelString: workerCodeModel,
      prices: PRICES[workerCodeModel],
      skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${workerCodeJobDescription}`,
      availableTools: ["issue_quote", "submit_job", "pay", "redeem_claim", "get_balances", "get_print"],
      privateKeyHex: toHex(process.env.WORKER_CODE_PRIVATE_KEY, "WORKER_CODE_PRIVATE_KEY"),
      address: workerCodeAddressHex,
      erc8004Id: workerCodeErc8004Id,
      rpcUrl,
      maxOutputTokens: 4500,
    },
    // WORKER-EXTRACT excluded from this real run (2026-09-26): the GOOGLE_API_KEY backing
    // gemini-3.1-pro-preview returned a real 402 "prepayment credits are depleted" mid-run — an
    // external billing constraint, not retryable (isRetryableError correctly only retries
    // 429/5xx) and not something this script can fix. WORKER-EXTRACT had no real job this window
    // regardless (no extract-class task exists here — see workerExtractJobDescription/its own
    // comment above) and contributes nothing to the real question this window answers
    // (ORCHESTRATOR's delegation/asset choice on the "code" job), so excluding it changes nothing
    // structural about the test — same disclosed-exclusion pattern as HEDGER above, for a
    // different real reason. void workerExtractAdapter/workerExtractJobDescription/
    // workerExtractAddress: kept defined above (unused here) in case Google billing is restored
    // and this run is repeated with the full roster.
    {
      agentId: "ISSUER-A",
      adapter: issuerAAdapter,
      modelString: issuerAModel,
      prices: PRICES[issuerAModel],
      skillPackText: issuerSkillPackText("ISSUER-A"),
      availableTools: ["mint_claim", "serve_redemption", "check_headroom", "get_print"],
      privateKeyHex: toHex(process.env.ISSUER_A_PRIVATE_KEY, "ISSUER_A_PRIVATE_KEY"),
      address: issuerAAddress,
      erc8004Id: erc8004IdFor(issuerAAddress),
      rpcUrl,
      maxOutputTokens: 1500,
    },
    {
      agentId: "ISSUER-B",
      adapter: issuerBAdapter,
      modelString: issuerBModel,
      prices: PRICES[issuerBModel],
      skillPackText: issuerSkillPackText("ISSUER-B"),
      availableTools: ["mint_claim", "serve_redemption", "check_headroom", "get_print"],
      privateKeyHex: toHex(process.env.ISSUER_B_PRIVATE_KEY, "ISSUER_B_PRIVATE_KEY"),
      address: issuerBAddress,
      erc8004Id: erc8004IdFor(issuerBAddress),
      rpcUrl,
      maxOutputTokens: 1500,
    },
  ];

  // Per-agent inference caps — workers weighted higher (real authoring work), issuers/idle
  // WORKER-EXTRACT weighted lower, matching the plan's own "workers weighted higher than issuers"
  // ratio. HEDGER excluded from this window entirely (see this file's own top comment) — zeroed
  // out, not omitted, since BudgetCeiling's constructor needs every AgentId.
  const zero = { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" } as const;
  const ceiling = new BudgetCeiling({
    ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "2" },
    "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 3, maxInferenceUsd: "0.1" },
    "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 8, maxInferenceUsd: "0.5" },
    "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 8, maxInferenceUsd: "0.5" },
    HEDGER: zero,
  });
  const budget = new ExperimentBudget({
    ceiling,
    runCapUsd: RUN_CAP_USD,
    experimentCapUsd: EXPERIMENT_CAP_USD,
    ledgerPath: LEDGER_PATH,
  });

  const illustrativePrint: Print = {
    version: "SIU-2026a",
    print_id: ILLUSTRATIVE_PRINT_ID,
    date: new Date().toISOString().slice(0, 10),
    status: "provisional",
    basket_costs: [],
    weights: { source: "equal", values: [] },
    dated_siu: "0.0100",
    exchange_rate_table: [],
  } as unknown as Print;

  const deps: RunnerDeps = {
    chainReader: new ViemChainReader(deployment, rpcUrl),
    deployment,
    escrowAddress: process.env.TOUCHSTONE_ESCROW_ADDRESS ?? "0x0",
    runGateHardeningChecks,
    loadPrint: async () => illustrativePrint,
    isReconciled: async () => false,
  };

  const mintContext: MintContext = {
    publisherPrivateKeyHex: toHex(process.env.TOUCHSTONE_PUBLISHER_KEY, "TOUCHSTONE_PUBLISHER_KEY"),
    printId: ILLUSTRATIVE_PRINT_ID,
    nanoUsdPerSiu: ILLUSTRATIVE_NANO_USD_PER_SIU,
    validitySeconds: 3600n,
  };

  const runId = `p5-window1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: modelAssignment,
    seed: "p5-window1-2026-09-26",
  };

  console.log("Starting WP-7 P5 window 1 — five-agent roster (HEDGER excluded, see top comment)");
  console.log(`ORCHESTRATOR=${orchestratorModel} (empirically verified weak — see deployment record)`);
  console.log(`WORKER-CODE=${workerCodeModel}  ISSUER-A=${issuerAModel}  ISSUER-B=${issuerBModel}`);
  console.log(`WORKER-EXTRACT (${workerExtractModel}) excluded from this real run: GOOGLE_API_KEY returned a real 402 "prepayment credits depleted" on a prior attempt — external billing constraint, not this window's roster design, and not load-bearing for the real question this window answers.`);
  console.log(`Experiment ledger so far: $${budget.experimentTotalUsd()}`);
  console.log(`Run recorded to: ${RUNS_ROOT}/${runId}\n`);

  const result = await runFullRunWindow({
    windowId: "p5-window1",
    roster,
    job,
    maxTurnsPerAgent: 10,
    budget,
    deps,
    runsRoot: RUNS_ROOT,
    runId,
    manifest,
    windowFrom,
    windowTo,
    mintContext,
    onTurn: (agentId, turn) => {
      const gateNote = turn.gateResult
        ? ` gate=${turn.gateResult.passed ? "PASS" : "FAIL"} (${turn.gateResult.summary})`
        : turn.quarantinedNonDeterministicGate
          ? " QUARANTINED (non-deterministic gate)"
          : "";
      console.log(
        `[${agentId}] Turn ${turn.turn}: prompt=${turn.promptChars} chars, projected=$${turn.projectedUsd}, ` +
          `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms -> ${turn.parsed.slice(0, 200)}${gateNote}`,
      );
    },
  });

  console.log("\n=== RESULT ===");
  console.log(`passed: ${result.passed}${result.passedBy ? ` (by ${result.passedBy})` : ""}`);
  console.log(`turnsByAgent: ${JSON.stringify(result.turnsByAgent)}`);
  console.log(`totalRealizedUsd: $${result.totalRealizedUsd}`);
  console.log(`haltedReason: ${JSON.stringify(result.haltedReason)}`);
  console.log(`Experiment ledger total now: $${budget.experimentTotalUsd()}`);
  console.log(`Run cap used this run: $${budget.runTotalUsd()} of $${RUN_CAP_USD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
