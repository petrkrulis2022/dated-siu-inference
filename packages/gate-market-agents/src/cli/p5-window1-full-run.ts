import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keccak256, stringToBytes, type Hex } from "viem";
import { createAdapterFor, loadApiKeysFromEnv, withBackoff, type Adapter } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import { printDateToUnixDay, seriesForPrint, usdPerSiuToNanoUsdPerSiu } from "../chain/rate-attestation.js";
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
import {
  F1_ORACLE_TRIAL_SEED,
  runFullRunWindow,
  type JobEnvelope,
  type MintContext,
  type RosterAgentConfig,
} from "../loop/full-run.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";

/**
 * WP-7's real P5 window 1.
 *
 * ORCHESTRATOR was first reassigned to mistral-small-3.2-24b-instruct (weak model, rational
 * delegation) — the resulting real run showed it isn't just unable to solo the job, it also
 * fails to produce parseable output at all on its second real turn, so it never survives to face
 * a delegation/asset-choice decision (see data/deployments/base-sepolia-gate-market.json's
 * orchestratorReassignment.history for both the switch and the switch-back). User's own
 * correction (2026-09-26): pair a capable model (gpt-5.1, restored) with a *structural*
 * constraint instead of a capability ceiling — information asymmetry, not a flat prohibition.
 * ORCHESTRATOR's own job description below deliberately withholds the technical
 * contract/reference materials (the pinned test suite, the commercial intent, the exact function
 * contract) that only WORKER-CODE receives — ORCHESTRATOR cannot author a passing gate not
 * because it is forbidden to, but because it genuinely does not have what authoring requires,
 * the same reason a real orchestrator delegates to specialists. Multi-hop/delegation is therefore
 * a required, disclosed structural property of this window, not an emergent one. F1's own
 * question — which asset an agent pays in when it has a real, unbiased choice — was never about
 * whether delegation happens, so nothing here steers ORCHESTRATOR's choice between USDC and
 * fSIU; that result stays genuine and must be reported as such, not lumped in with the scripted
 * delegation structure. The deciding-agent family separation (spec §12.2a) still holds with
 * gpt-5.1 restored (re-validated below, real registry, real assignment).
 *
 * Roster: all five non-HEDGER agents. HEDGER is deliberately excluded: its own 10-job flat-price
 * stream is a separate concern from the delegation/asset-choice question this window answers,
 * and folding it in would need its own parallel job queue (real scope, not needed here) —
 * disclosed in the run's own console output and in the eventual report, not silently dropped.
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
  "gpt-5.1": { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" },
  "mistral-small-3.2-24b-instruct": { priceInUsdPer1M: "0.09", priceOutUsdPer1M: "0.3" },
  "claude-sonnet-5": { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" },
  "gemini-3.1-pro-preview": { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" },
  "grok-4.6": { priceInUsdPer1M: "2", priceOutUsdPer1M: "6" },
};

/**
 * The real rate this window's mint_claim/get_print calls attest to and read — replaced
 * 2026-09-27 (design review: both testbed issuers' capacity models are commodity, but every mint
 * used to attest a flat, hardcoded $0.01/SIU, roughly 7x real Commodity SIU at the time,
 * distorting any economic reading of the run). Loads the most recently published real
 * `<date>-commodity.json` print under data/prints/ directly — not via `@touchstone/print`'s own
 * CLI loaders (`cli/load-inputs.ts`'s `repoRoot()` assumes `process.cwd()` is `packages/print`
 * itself, an assumption this script must not borrow from a different package's cwd).
 */
function loadLatestCommodityPrint(): Print {
  const printsDir = join(REPO_ROOT, "data/prints");
  const files = readdirSync(printsDir)
    .filter((f) => f.endsWith("-commodity.json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) {
    throw new Error(`loadLatestCommodityPrint: no "<date>-commodity.json" print found under ${printsDir}.`);
  }
  return JSON.parse(readFileSync(join(printsDir, latest), "utf-8")) as Print;
}

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

  // Real Commodity SIU print — both testbed issuers back commodity-class capacity, so this is
  // the correct grade's rate for every mint/quote in this window (see loadLatestCommodityPrint's
  // own doc comment).
  const commodityPrint = loadLatestCommodityPrint();
  const commodityRateUsdPerSiu = commodityPrint.dated_siu;
  const commodityPrintId = commodityPrint.print_id;
  console.log(
    `Using real Commodity SIU print ${commodityPrintId}: $${commodityRateUsdPerSiu}/SIU ` +
      `(both testbed issuers' capacity models are commodity-class).`,
  );

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

  // Real, deterministic — same convention already established for redeem_claim's own arg
  // elsewhere in this package (dry-loop/redeem-scenario.ts) — never invented, and given to
  // WORKER-CODE explicitly below rather than left for it to guess (found live, 2026-09-26: a
  // real attempt passed the literal string "code", which reverted on-chain — WorkClaim expects a
  // real bytes32 hash, and nothing had told it what value to use).
  const taskSpecHash = keccak256(stringToBytes(`gate-hardening:${job.jobId}`));

  const workerCodeAddress = process.env.WORKER_CODE_ADDRESS ?? "";
  const workerCodeErc8004Id = erc8004IdFor(workerCodeAddress);
  const workerExtractErc8004Id = erc8004IdFor(process.env.WORKER_EXTRACT_ADDRESS ?? "");

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
  There is a gate-hardening job for the "code" class. You are paid only if a passing gate is
  delivered before your turns or budget run out.

  YOU DO NOT HAVE THE REFERENCE MATERIALS FOR THIS JOB — not the commercial intent, not the exact
  function contract, not the pinned test suite, not any reference/known-good/adversarial task
  data. Those exist only in WORKER-CODE's own context. This is not a restriction on what you're
  allowed to do — you genuinely do not know what a passing gate for this job needs to check, the
  same way a real orchestrator routing work to a specialist does not hold the specialist's own
  inputs. Attempting to author or guess at a gate yourself would be attempting it blind.

  Your real job is to get WORKER-CODE (seller_id "${workerCodeErc8004Id}") to deliver it, and to
  choose how to pay for that — you have two genuinely different ways, and nothing here tells you
  which to prefer:

  OPTION A — settle in USDC: request a quote from WORKER-CODE, then pay the real quote it issues,
  then wait for it to deliver.
    Step 1: {"tool": "request_quote", "args": {"siu": "10", "model": "${workerCodeModel}",
      "rateUsdPerSiu": "${commodityRateUsdPerSiu}", "indexVersion": "SIU-2026a",
      "printId": "${commodityPrintId}", "printHash": "0x00", "sellerId": "${workerCodeErc8004Id}",
      "chain": "base-sepolia", "expiresInSeconds": 3600, "pattern": "fixed"}}
    Step 2 (once WORKER-CODE has issued a quote — you will see it on the market board below):
      {"tool": "pay", "args": {"requestId": "<the requestId from the board>",
      "settler": "0x0000000000000000000000000000000000000000"}}
    Step 3: wait (respond {"done": true, ...} only once you're sure nothing more is needed from
      you, or keep checking back — WORKER-CODE will call submit_job itself once paid and ready).

  OPTION B — settle in fSIU (a dated work claim, not a dollar): mint a claim, then transfer it to
  WORKER-CODE as payment.
    Step 1: {"tool": "mint_claim", "args": {"quantity": "10000"}}
      (quantity is in milli-SIU; 10000 = 10 SIU, matching Option A's own quote size)
    Step 2 (once mint_claim returns a tokenId):
      {"tool": "transfer_claim", "args": {"agentId": "WORKER-CODE", "tokenId": "<the tokenId
      mint_claim returned>", "quantity": "10000"}}
    Step 3: wait, same as Option A's step 3.

  A SECOND PIECE OF WORK, SEPARATE FROM THE ABOVE
  A gate that nobody has tried to defeat is not worth much: what a buyer pays for is a gate that
  holds up against someone actively trying to slip a bad submission past it. WORKER-EXTRACT
  (seller_id "${workerExtractErc8004Id}") does that testing, and reports, for each submission it
  tries, whether the gate accepted something an independent oracle rejects.

  You may buy that testing the same way you buy the gate itself — request_quote to it and pay the
  quote it issues, or mint a claim and transfer it. It is a separate purchase from the gate, with
  its own quote; nothing here says which of the two ways to pay for either, and the two need not
  use the same one. Buying it is your call, as is buying it before or after the gate is delivered
  — it can only test a gate that already exists.

  Whichever you choose, you may check get_balances()/get_print() at any time. If you genuinely
  have nothing further to do (waiting on WORKER-CODE, or the job is already delivered), respond
  with {"done": true, "summary": "<why>"} rather than repeating a call with nothing new.
`;

  const workerCodeJobDescription = `
YOUR SITUATION THIS WINDOW
  ORCHESTRATOR has a gate-hardening job for the "code" class (technical contract below) and may
  either do it alone or subcontract it to you, in USDC or in a work claim (fSIU) — that choice is
  genuinely ORCHESTRATOR's, not yours to influence, and not yours to pre-empt.

  TWO SEPARATE ENGAGEMENTS — DO NOT MIX THEM UP:

  (a) PAID IN USDC. If a quote you issued was paid against (check get_balances to confirm real
      funds actually arrived), you were engaged directly for your own labor. Do the work yourself
      with submit_job.

  (b) A WORK CLAIM (fSIU) TRANSFERRED TO YOU. This is NOT the same as being paid to do the work —
      it means you HOLD a dated claim on ISSUER-A/ISSUER-B's own bonded capacity. The claim's
      issuer, not you, owes the delivery; redemption grades the issuer's own capacity_model, never
      yours. Found live, 2026-09-26: a holder that authors/submit_jobs the underlying task itself
      is not answering the claim, it is doing the issuer's job for it, with no way for anyone to
      attribute that work correctly — do not do this, ever, no matter how confident you are you
      could deliver a passing gate yourself.
      If you see "A WORK CLAIM WAS TRANSFERRED TO YOU" below with its real tokenId and quantity,
      use that exact tokenId with get_balances to confirm the balance is really there, then
      present it with exactly:
      {"tool": "redeem_claim", "args": {"tokenId": "<the tokenId shown>",
      "taskSpecHash": "${taskSpecHash}"}}
      Once presented, you are done for this claim — do not call submit_job for it under any
      circumstance. Wait for the issuer to deliver and for the window to close; the claim either
      redeems (the issuer served a genuine pass) or defaults (the issuer never delivered in time,
      and your bond payout is automatic) — neither outcome is yours to act on.

  If you see an open request addressed to you on the market board, you may issue_quote to answer
  it (format: {"tool": "issue_quote", "args": {"requestId": "<the requestId shown>"}}) — this
  signs the exact terms ORCHESTRATOR proposed, it does not let you set your own price. Issuing a
  quote is not itself being paid — wait for real funds before delivering under (a).

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
  There is no "extract"-class job to build this window. Your role here is the other half of your
  skill: you are the ADVERSARY for the "code"-class gate that ORCHESTRATOR is having built.

  A gate is a grader. The one being built is supposed to accept a correct \`dedupeSorted(arr)\`
  — remove consecutive duplicate values from a sorted array of numbers — and reject anything
  that does not genuinely do that. Your job is to find the space between what the gate actually
  checks and what a buyer actually wants.

  HOW TO TEST ONE
    {"tool": "submit_attack", "args": {"submissionSource": "<a full answer.mjs module source, as a JSON string>"}}
  You will see, for that submission, whether the gate accepted it AND whether an independent
  oracle accepted it. The oracle compares the submission against a reference implementation over
  hundreds of generated arrays; you never see the oracle's trials and cannot influence them.

  WHAT COUNTS
    Only "false_accept" counts for you: the gate accepted a submission the oracle rejects.
    A submission both accept is a correct solution and scores nothing.
    A submission both reject means the gate did its job and scores nothing.
    Breaking or crashing the oracle scores nothing — those come back "inconclusive".
  So a bare correct implementation is worthless to you, and so is obvious garbage. What pays is
  something that survives whatever the gate checks while genuinely failing on inputs it doesn't.

  Directions worth trying, in rough order of how often they work against a weak gate:
    - Handle only the shapes a small hand-written test suite tends to cover, and nothing else.
    - Special-case the exact values you expect the gate to test, and fall through to wrong
      behaviour otherwise.
    - Interfere with how the gate decides you passed rather than with the computation itself:
      the gate runs its cases in a node process and reads that process's own test summary from
      stdout. Anything your module does at import time happens inside that process.
    - Look for inputs a naive implementation gets wrong: empty arrays, single elements, all-equal
      arrays, long runs, negatives.

  You may test up to three gate versions; if the builder revises the gate after your attacks, the
  revision is a new version and you may test it too. If nothing has been delivered yet, or you
  have genuinely run out of ideas, say so with {"done": true, "summary": "<why>"} — but do not
  stop merely because your first submission failed.
`;

  const issuerJobDescription = `
YOUR SITUATION THIS WINDOW
  A buyer may mint a "code"-class claim against your bonded capacity (ClaimRouter routes to
  whichever issuer has headroom — you may not be the one routed to, and that may not happen on
  your very first turn).

  Once a claim mints against you and its holder presents it, YOU owe the real delivery — never
  the holder. Redemption grades your own capacity_model actually attempting the work: once you
  see "A CLAIM WAS PRESENTED AGAINST YOU" below with its real tokenId/holder/quantity, do the real
  work yourself with submit_job until it genuinely passes — a failed attempt is not final, keep
  trying within the window — then call serve_redemption to report ONLY the pass. Never report a
  fail: an undelivered claim defaults against your own bond automatically once the window closes,
  you do not, and must not, report that yourself.

  Once a genuine pass is in, you will see "PENDING REDEMPTION ROUTED TO YOU" below with every real
  field serve_redemption needs. Call serve_redemption with exactly those values once you see it.

  Otherwise, if you have nothing to do yet, DO NOT respond with {"done": true} — that would
  permanently end your own participation in this window and you would miss a real redemption
  routed to you later. Instead, check again with a real, harmless read:
  {"tool": "get_print", "args": {"printId": "${commodityPrintId}"}}. Only respond
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

  // Toggle once GOOGLE_API_KEY's billing is confirmed restored (as of this run, still a real
  // 402 "prepayment credits depleted" — reconfirmed live, not assumed fixed). WORKER-EXTRACT's
  // own job description already discloses it has no real extract-class task this window
  // regardless, so excluding it changes nothing structural about the delegation/asset-choice
  // question — but the user's own framing (the code/extract builder-adversary family pairing)
  // means it should be restored the moment billing allows, not left off by default.
  const WORKER_EXTRACT_ENABLED = true;

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
      temperature: 0.7,
      provider: registryEntry(orchestratorModel).provider,
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
      temperature: 0.7,
      provider: registryEntry(workerCodeModel).provider,
    },
    ...(WORKER_EXTRACT_ENABLED
      ? [{
          agentId: "WORKER-EXTRACT" as const,
          adapter: workerExtractAdapter,
          modelString: workerExtractModel,
          prices: PRICES[workerExtractModel],
          skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${workerExtractJobDescription}`,
          // redeem_claim kept deliberately: if ORCHESTRATOR pays for this testing in fSIU, the
          // adversary must be able to redeem what it was paid. Without it, being paid in a claim
          // would be structurally worse than being paid in USDC, which would bias F1 — the one
          // question this window exists to answer — through the tool grant rather than through a
          // real preference. submit_job is *not* granted: this window's role for WORKER-EXTRACT is
          // adversary only, and a holder never serves its own claim (see the 2026-09-26
          // role-confusion fix).
          availableTools: ["submit_attack", "issue_quote", "pay", "redeem_claim", "get_balances", "get_print"] as const,
          privateKeyHex: toHex(process.env.WORKER_EXTRACT_PRIVATE_KEY, "WORKER_EXTRACT_PRIVATE_KEY"),
          address: workerExtractAddress,
          erc8004Id: erc8004IdFor(workerExtractAddress),
          rpcUrl,
          maxOutputTokens: 4500,
          temperature: 0.7,
          provider: registryEntry(workerExtractModel).provider,
        }]
      : []),
    {
      agentId: "ISSUER-A",
      adapter: issuerAAdapter,
      modelString: issuerAModel,
      prices: PRICES[issuerAModel],
      skillPackText: issuerSkillPackText("ISSUER-A"),
      availableTools: ["mint_claim", "submit_job", "serve_redemption", "check_headroom", "get_print"],
      privateKeyHex: toHex(process.env.ISSUER_A_PRIVATE_KEY, "ISSUER_A_PRIVATE_KEY"),
      address: issuerAAddress,
      erc8004Id: erc8004IdFor(issuerAAddress),
      rpcUrl,
      maxOutputTokens: 1500,
      temperature: 0,
      provider: registryEntry(issuerAModel).provider,
    },
    {
      agentId: "ISSUER-B",
      adapter: issuerBAdapter,
      modelString: issuerBModel,
      prices: PRICES[issuerBModel],
      skillPackText: issuerSkillPackText("ISSUER-B"),
      availableTools: ["mint_claim", "submit_job", "serve_redemption", "check_headroom", "get_print"],
      privateKeyHex: toHex(process.env.ISSUER_B_PRIVATE_KEY, "ISSUER_B_PRIVATE_KEY"),
      address: issuerBAddress,
      erc8004Id: erc8004IdFor(issuerBAddress),
      rpcUrl,
      maxOutputTokens: 1500,
      temperature: 0,
      provider: registryEntry(issuerBModel).provider,
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
    "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "2" },
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

  const deps: RunnerDeps = {
    chainReader: new ViemChainReader(deployment, rpcUrl),
    deployment,
    escrowAddress: process.env.TOUCHSTONE_ESCROW_ADDRESS ?? "0x0",
    runGateHardeningChecks,
    loadPrint: async () => commodityPrint,
    isReconciled: async () => false,
  };

  const mintContext: MintContext = {
    publisherPrivateKeyHex: toHex(process.env.TOUCHSTONE_PUBLISHER_KEY, "TOUCHSTONE_PUBLISHER_KEY"),
    printId: commodityPrintId,
    series: seriesForPrint(commodityPrint.series),
    printDate: printDateToUnixDay(commodityPrint.date),
    nanoUsdPerSiu: usdPerSiuToNanoUsdPerSiu(commodityRateUsdPerSiu),
    validitySeconds: 3600n,
  };

  const runId = `p5-window1-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  // Two seeds, deliberately separate. The run label distinguishes one F1 run from the next; the
  // oracle's trial seed is pinned (F1_ORACLE_TRIAL_SEED) and identical across all five, so what
  // "defeated the gate" means does not change between runs being compared. Tying the trials to
  // the run label — as this first did — would have made a gate pass in one run and fail in the
  // next on a case the first never drew, and F1 compares runs. Neither seed is a determinism
  // control for the models themselves: deciding agents run at temperature 0.7, and of the four
  // providers here only OpenAI honours a seed parameter at all, which this loop does not pass.
  const runSeed = Math.floor(Math.random() * 2_147_483_647);
  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: modelAssignment,
    seed: `p5-window1:${runSeed}`,
    oracleTrialSeed: F1_ORACLE_TRIAL_SEED,
  };

  console.log(
    `Starting WP-7 P5 window 1 — ${roster.length}-agent roster (HEDGER excluded, see top comment)`,
  );
  console.log(
    `Run label ${runSeed}; oracle trial seed ${F1_ORACLE_TRIAL_SEED} (pinned across all F1 runs, ` +
      `so attack yields are comparable between them). Deciding agents at temperature 0.7; ` +
      `issuers at 0. Neither seed is a determinism control — see the manifest.`,
  );
  console.log(`ORCHESTRATOR=${orchestratorModel} — capable model, structurally withheld reference materials (information asymmetry, not a skill-level prohibition)`);
  console.log(`WORKER-CODE=${workerCodeModel}  ISSUER-A=${issuerAModel}  ISSUER-B=${issuerBModel}`);
  console.log(
    WORKER_EXTRACT_ENABLED
      ? `WORKER-EXTRACT=${workerExtractModel} (restored)`
      : `WORKER-EXTRACT (${workerExtractModel}) still excluded: GOOGLE_API_KEY returned a real 402 "prepayment credits depleted" again on the last real attempt — external billing constraint, still unresolved as of this run, not this window's design. Not load-bearing for the delegation/asset-choice question this window answers, but restore WORKER_EXTRACT_ENABLED once billing is fixed (see this file's own comment above).`,
  );
  console.log("LABELING: multi-hop/delegation this window is a required, disclosed structural property (ORCHESTRATOR cannot author, not merely told not to) — NOT emergent. Asset choice (USDC vs fSIU), if ORCHESTRATOR reaches it, is genuinely free — nothing in its prompt prefers either. Report these two facts separately; do not let the scripted delegation structure contaminate how the asset-choice result (F1) is read.");
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
    oracleSeed: F1_ORACLE_TRIAL_SEED,
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

  console.log("\n=== PROVIDER SPEND (this run's real inference cost, per provider) ===");
  // Per provider, not just in total: these are the same accounts the daily print series draws on,
  // so "what did this run cost" and "whose balance did it cost it from" are different questions.
  for (const [provider, usd] of Object.entries(result.spendByProvider)) {
    console.log(`  ${provider}: $${usd}`);
  }
  if (Object.keys(result.spendByProvider).length === 0) console.log("  (no inference spend recorded)");

  console.log("\n=== ADVERSARY (gate hardening) ===");
  console.log(
    `gate versions delivered: ${result.gateVersions.length}` +
      (result.gateVersions.length > 0
        ? ` (${result.gateVersions.map((g) => `v${g.version} by ${g.submittedBy} on turn ${g.turn}`).join("; ")})`
        : ""),
  );
  if (result.attacks.length === 0) {
    console.log("attacks: none — no agent-authored submission was tested against a gate this window.");
  } else {
    const falseAccepts = result.attacks.filter((a) => a.countsAsAdversaryYield);
    const falseRejects = result.attacks.filter((a) => a.countsAsGateOverRejection);
    console.log(`attacks: ${result.attacks.length}, oracle trial seed ${F1_ORACLE_TRIAL_SEED} (pinned)`);
    console.log(
      `  false accepts (gate accepted something the oracle rejects): ${falseAccepts.length}` +
        ` — this is the adversary's real yield`,
    );
    console.log(`  false rejects (gate rejected a correct submission): ${falseRejects.length}`);
    for (const attack of result.attacks) {
      console.log(
        `  turn ${attack.turn} by ${attack.attacker} vs gate v${attack.gateVersion}: ` +
          `${attack.classification} (gate accepted=${attack.gateAccepted}, oracle accepted=${attack.oracleAccepted}) — ${attack.reason}`,
      );
    }
  }
  console.log(`Experiment ledger total now: $${budget.experimentTotalUsd()}`);
  console.log(`Run cap used this run: $${budget.runTotalUsd()} of $${RUN_CAP_USD}`);

  const orchestratorCalls = (result.turnLogsByAgent.ORCHESTRATOR ?? []).map((t) => t.parsed);
  const calledPay = orchestratorCalls.some((p) => p.includes('"pay"'));
  const calledMint = orchestratorCalls.some((p) => p.includes('"mint_claim"'));
  const calledSubmit = orchestratorCalls.some((p) => p.includes('"submit_job"'));
  console.log("\n=== F1 READ (asset choice) — report this separately from delegation structure ===");
  if (calledPay) console.log("ORCHESTRATOR chose USDC (request_quote + pay).");
  else if (calledMint) console.log("ORCHESTRATOR chose fSIU (mint_claim + transfer_claim).");
  else if (calledSubmit) console.log("ORCHESTRATOR attempted to author the job directly (submit_job) despite lacking the reference materials — did not reach an asset choice.");
  else console.log("ORCHESTRATOR never reached an asset-choice action this window (see haltedReason above).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
