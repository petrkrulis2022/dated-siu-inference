import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
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
import { loadSkill } from "../skills/registry.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import type { ModelPrices } from "../budget/inference-cost.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { validateModelAssignment, type ModelAssignments } from "../pack/model-assignment.js";
import { erc8004IdFor } from "../identity/resolve.js";
import type { RunnerDeps } from "../deps.js";
import { loadGateMarketDeployment } from "../chain/deployment.js";
import { ViemChainReader } from "../chain/reader.js";
import { runFullRunWindow, type JobEnvelope } from "../loop/full-run.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * WP-7's real P4: "ORCHESTRATOR alone, doing the work itself, one job to a passing gate" — run
 * through this package's own new general loop (`loop/full-run.ts`), configured with a one-agent
 * roster, so this is a real smoke test of the P5 machinery (turn scheduling, ExperimentBudget's
 * hierarchy, friction logging, the gate-determinism check), not a separate, narrower code path.
 *
 * Same real task as code-gate-authoring-pass.ts (the pinned dedupeSorted test suite) — a real,
 * already-proven, real-money-tested job, not a fresh, unvalidated one for this first real run
 * against a live deployment.
 */

// ORCHESTRATOR's real assigned model (data/deployments/base-sepolia-gate-market.json's own
// modelAssignment record) — gpt-5.1, already used by smoke-pass.ts's own P4 precursor.
const MODEL_STRING = "gpt-5.1";
const PRICES: ModelPrices = { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" }; // real, current registry price, 2026-09-25

const MAX_TURNS = 40;
const RUN_CAP_USD = "30";
const EXPERIMENT_CAP_USD = "150";
const PER_AGENT_INFERENCE_CAP_USD = "2"; // matches code-gate-authoring-pass.ts's own real-tested ceiling
const MAX_OUTPUT_TOKENS = 4500;

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const LEDGER_PATH = join(REPO_ROOT, "data/gate-market/experiment-ledger.json");

function withPinnedTestSuite(instance: ReferenceTaskInstance): ReferenceTaskInstance {
  return { ...instance, files: { ...instance.files, "pinned-test-cases.txt": PINNED_TEST_SUITE } };
}
function withPinnedTestSuiteHeldOut(held: HeldOutInstance): HeldOutInstance {
  return { ...held, referenceInstance: withPinnedTestSuite(held.referenceInstance) };
}

async function main(): Promise<void> {
  const registry = JSON.parse(readFileSync(join(REPO_ROOT, "data/registry/models.json"), "utf-8"));

  // Real model-assignment validation (spec §12.2a) against this run's real, recorded assignment —
  // refuses to start on a violation, exactly as a real run should.
  const modelAssignment: ModelAssignments = JSON.parse(
    readFileSync(join(REPO_ROOT, "data/deployments/base-sepolia-gate-market.json"), "utf-8"),
  ).roster.modelAssignment;
  validateModelAssignment(modelAssignment, registry);
  console.log("Model assignment validated (spec §12.2a): OK\n");

  const deployment = loadGateMarketDeployment();
  const apiKeys = loadApiKeysFromEnv();
  const adapter = createAdapterFor({ provider: "openai", host: "openai" }, apiKeys);
  const skill = loadSkill("subcontract-and-settle");

  const referenceInstance = withPinnedTestSuite(CODE_REFERENCE);
  const heldOutInstances = CODE_HELD_OUT_INSTANCES.map(withPinnedTestSuiteHeldOut) as [
    HeldOutInstance,
    ...HeldOutInstance[],
  ];

  const jobDescription = `
YOUR JOB THIS RUN
  You are ORCHESTRATOR, working alone (P4 — no other agents in this run, no subcontracting
  available). Author a gate that validates a submitted fix against the commercial intent below —
  from scratch. No candidate gate, no example submission, and no adversarial cases are given to
  you; none exist yet for you to see.

THE FUNCTION UNDER TEST: a submission provides a named export \`dedupeSorted(arr)\` from a file
  called answer.mjs. It must remove consecutive duplicate values from a sorted array of numbers,
  preserving order.

COMMERCIAL INTENT:
  ${CODE_COMMERCIAL_INTENT}

THE PINNED TEST SUITE (the real, operator-authored test cases your gate must run — reproduced
here exactly, and also available to your gate at runtime as data; see the technical contract
below):
---
${PINNED_TEST_SUITE}---
  Each line above is a real node:test case body. It assumes \`test\` (from "node:test"), \`assert\`
  (from "node:assert/strict") and \`dedupeSorted\` (the submission's own export) are already
  imported and in scope wherever it runs — your gate is responsible for making that true before
  running these cases, not for rewriting, reformatting, or reinventing them.

HOW A GATE IS AUTHORED (technical contract, not a solution):
  Your gate's source is a JavaScript ES module. It must export:
    export async function gate({ referenceDir, submissionDir }) {
      // referenceDir + "/pinned-test-cases.txt" holds the exact test-case bodies shown above, as
      // data — read it fresh every time you are called. Never re-type the test bodies as literals
      // in your own gate source, and never substitute different test cases of your own.
      // submissionDir + "/answer.mjs" is the submission being graded.
      // Your gate must genuinely execute the pinned cases against THIS submission's own
      // dedupeSorted every time it is called and report the real result — not merely inspect the
      // submission's source text, and not reuse a verdict computed for a different submission.
      // Return { accept: <boolean>, reason: <string> }.
    }
  It runs inside a sandbox with node:fs and node:child_process available (spawning the node
  binary itself, at process.execPath, is allowed — that is how you can run a real test file) — no
  network, no other imports beyond node builtins. Any file your gate needs to write as part of
  grading must be written under referenceDir, never under submissionDir.

  IMPORTANT — read this carefully: your gate will be graded not just once, but multiple times,
  including against submissions you have never seen. It must produce the correct verdict every
  time by genuinely running the pinned tests against that specific submission's own code.

TO SUBMIT YOUR GATE, respond with exactly:
  {"tool": "submit_job", "args": {"source": "<your full gate module source as a JSON string>"}}
  The source must be valid JavaScript, correctly escaped as one JSON string value. If your
  submitted gate does not pass every check, you will see exactly which check failed and why on
  your next turn — revise and resubmit within your turn budget.
`;

  const skillPackText = `${skill.promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${jobDescription}`;

  const job: JobEnvelope = {
    jobId: "p4-full-run-job",
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

  const zero = { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" } as const;
  const ceiling = new BudgetCeiling({
    "ISSUER-A": zero,
    "ISSUER-B": zero,
    ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: MAX_TURNS, maxInferenceUsd: PER_AGENT_INFERENCE_CAP_USD },
    "WORKER-CODE": zero,
    "WORKER-EXTRACT": zero,
    HEDGER: zero,
  });
  const budget = new ExperimentBudget({
    ceiling,
    runCapUsd: RUN_CAP_USD,
    experimentCapUsd: EXPERIMENT_CAP_USD,
    ledgerPath: LEDGER_PATH,
  });

  const deps: RunnerDeps = {
    chainReader: new ViemChainReader(deployment, process.env.BASE_SEPOLIA_RPC_URL ?? ""),
    deployment,
    escrowAddress: process.env.TOUCHSTONE_ESCROW_ADDRESS ?? "0x0",
    runGateHardeningChecks,
    loadPrint: async () => {
      throw new Error("get_print is not exercised by this pass.");
    },
    isReconciled: async () => false,
  };

  const runId = `p4-full-run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: modelAssignment,
    seed: "p4-full-run-2026-09-25",
  };

  console.log(`Starting WP-7 P4 — ORCHESTRATOR alone, model=${MODEL_STRING}, real Base Sepolia deployment`);
  console.log(`Bounds: maxTurns=${MAX_TURNS}, per-agent inference cap=$${PER_AGENT_INFERENCE_CAP_USD}, run cap=$${RUN_CAP_USD}, experiment cap=$${EXPERIMENT_CAP_USD}`);
  console.log(`Experiment ledger so far: $${budget.experimentTotalUsd()}`);
  console.log(`Run recorded to: ${RUNS_ROOT}/${runId}\n`);

  const result = await runFullRunWindow({
    windowId: "p4",
    roster: [
      {
        agentId: "ORCHESTRATOR",
        adapter,
        modelString: MODEL_STRING,
        prices: PRICES,
        skillPackText,
        availableTools: ["submit_job"],
        privateKeyHex: process.env.ORCHESTRATOR_PRIVATE_KEY ?? "",
        address: process.env.ORCHESTRATOR_ADDRESS ?? "",
        erc8004Id: erc8004IdFor(process.env.ORCHESTRATOR_ADDRESS ?? ""),
        rpcUrl: process.env.BASE_SEPOLIA_RPC_URL ?? "",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      },
    ],
    job,
    maxTurnsPerAgent: MAX_TURNS,
    budget,
    deps,
    runsRoot: RUNS_ROOT,
    runId,
    manifest,
    onTurn: (agentId, turn) => {
      const gateNote = turn.gateResult
        ? ` gate=${turn.gateResult.passed ? "PASS" : "FAIL"} (${turn.gateResult.summary})`
        : turn.quarantinedNonDeterministicGate
          ? " QUARANTINED (non-deterministic gate)"
          : "";
      console.log(
        `[${agentId}] Turn ${turn.turn}: prompt=${turn.promptChars} chars, projected=$${turn.projectedUsd}, ` +
          `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms -> ${turn.parsed.slice(0, 160)}${gateNote}`,
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
