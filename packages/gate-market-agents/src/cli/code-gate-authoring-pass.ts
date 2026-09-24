import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
import {
  runGateHardeningChecks,
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
} from "@touchstone/task-pack-gate-hardening";
import type { HeldOutInstance, ReferenceTaskInstance } from "@touchstone/task-pack-gate-hardening";
import { loadSkill } from "../skills/registry.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import type { ModelPrices } from "../budget/inference-cost.js";
import type { RunnerDeps } from "../deps.js";
import { runGateAuthoringPass } from "../loop/gate-authoring-pass.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";

// claude-sonnet-5's real registry entry (data/registry/models.json) and real current price
// (data/registry/price-snapshot-merged-2026-09-24...json) — WORKER-CODE's already-agreed
// frontier-tier model from this session's earlier model-assignment discussion.
const MODEL_STRING = "claude-sonnet-5";
const PRICES: ModelPrices = { priceInUsdPer1M: "2", priceOutUsdPer1M: "10" };

const MAX_TURNS = 40;
const MAX_INFERENCE_USD = "2";

/** This pass asks the model to author a real test *harness* (spawns a subprocess, parses its
 * output), which reads longer than extract's value-comparator — raised from extract's 3000. */
const MAX_OUTPUT_TOKENS = 4500;

/** The pinned suite is only needed for this experimental pass (CODE_GATE_3_HARDENED embeds its
 * own tests directly, never reads referenceDir at all — see code.ts) — so it's added here, local
 * to this CLI entry, rather than into the shared CODE_REFERENCE / CODE_HELD_OUT_INSTANCES that
 * every other real fixture and test in this package also relies on. */
function withPinnedTestSuite(instance: ReferenceTaskInstance): ReferenceTaskInstance {
  return {
    ...instance,
    files: { ...instance.files, "pinned-test-cases.txt": PINNED_TEST_SUITE },
  };
}

function withPinnedTestSuiteHeldOut(held: HeldOutInstance): HeldOutInstance {
  return { ...held, referenceInstance: withPinnedTestSuite(held.referenceInstance) };
}

/**
 * submit_job never touches ctx.clients (same as the P4 smoke pass and the extract pass) — real
 * deps are only the real, no-model, sandboxed G1-G6 executor; everything chain-shaped is
 * stubbed/unused.
 */
function buildDeps(): RunnerDeps {
  return {
    chainReader: {
      usdcBalance: async () => 0n,
      claimBalance: async () => 0n,
      headroom: async () => 0n,
      issuanceLimit: async () => 0n,
      claimWindow: async () => ({ windowFrom: 0n, windowTo: 0n }),
      currentBlockTimestamp: async () => 0n,
    },
    deployment: {
      network: { name: "unused", chainId: 0 },
      usdc: { address: "0x0" },
      capacityBond: { address: "0x0" },
      claimRouter: { address: "0x0" },
      workClaim: { address: "0x0" },
    },
    escrowAddress: "0x0",
    runGateHardeningChecks,
    loadPrint: async () => {
      throw new Error("get_print is not exercised by this pass.");
    },
    isReconciled: async () => false,
  };
}

async function main(): Promise<void> {
  const apiKeys = loadApiKeysFromEnv();
  const adapter = createAdapterFor({ provider: "anthropic", host: "anthropic" }, apiKeys);

  const workerSkill = loadSkill("quote-and-deliver");

  const referenceInstance = withPinnedTestSuite(CODE_REFERENCE);
  const heldOutInstances = CODE_HELD_OUT_INSTANCES.map(withPinnedTestSuiteHeldOut) as [
    HeldOutInstance,
    ...HeldOutInstance[],
  ];

  const jobDescription = `
YOUR JOB THIS RUN
  You are WORKER-CODE, working alone (no subcontracting, no other agents in this run). Author a
  gate that validates a submitted fix against the commercial intent below — from scratch. No
  candidate gate, no example submission, and no adversarial cases are given to you; none exist yet
  for you to see.

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
  grading (for example, a combined test file that imports the pinned cases together with the
  submission) must be written under referenceDir, never under submissionDir.

  IMPORTANT — read this carefully: your gate will be graded not just once, but multiple times,
  including against submissions you have never seen. It must produce the correct verdict every
  time by genuinely running the pinned tests against that specific submission's own code — not by
  recognizing something about one particular submission's file content, and not by trusting
  anything the submission itself provides beyond the one export it's supposed to expose. A gate
  that cannot do this is not a verifier and is worthless for its real purpose.

TO SUBMIT YOUR GATE, respond with exactly:
  {"tool": "submit_job", "args": {"source": "<your full gate module source as a JSON string>"}}
  The source must be valid JavaScript, correctly escaped as one JSON string value (escape every
  newline as \\n and every double-quote as \\"). If your submitted gate does not pass every check,
  you will see exactly which check failed and why on your next turn — revise and resubmit within
  your turn budget.
`;

  const skillPackText = `${workerSkill.promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${jobDescription}`;

  const runId = `code-gate-authoring-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/code@0.0.0",
    agentConfigs: { "WORKER-CODE": { reasoningModel: MODEL_STRING } },
    seed: "code-gate-authoring-pass — no seeded randomness in this loop",
  };

  console.log(`Starting single-agent gate-authoring pass — WORKER-CODE alone, model=${MODEL_STRING}`);
  console.log(`Bounds: maxTurns=${MAX_TURNS}, maxInferenceUsd=$${MAX_INFERENCE_USD}`);
  console.log(`Run recorded to: ${RUNS_ROOT}/${runId}\n`);

  const result = await runGateAuthoringPass({
    adapter,
    modelString: MODEL_STRING,
    prices: PRICES,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    maxTurns: MAX_TURNS,
    maxInferenceUsd: MAX_INFERENCE_USD,
    agentId: "WORKER-CODE",
    skillPackText,
    availableTools: ["submit_job"],
    deps: buildDeps(),
    jobId: "code-gate-authoring-pass",
    taskClass: "code",
    envelope: {
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
    },
    runsRoot: RUNS_ROOT,
    runId,
    manifest,
    onTurn: (turn) => {
      const gateNote = turn.gateResult
        ? ` gate=${turn.gateResult.passed ? "PASS" : "FAIL"} (${turn.gateResult.summary})`
        : "";
      console.log(
        `Turn ${turn.turn}: prompt=${turn.promptChars} chars, projected=$${turn.projectedUsd}, ` +
          `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms -> ${turn.parsed.slice(0, 160)}${gateNote}`,
      );
    },
  });

  console.log("\n=== RESULT ===");
  console.log(`turnsUsed: ${result.turnsUsed}`);
  console.log(`totalRealizedUsd: $${result.totalRealizedUsd}`);
  console.log(`passed: ${result.passed}`);
  if (result.haltedReason) console.log(`haltedReason: ${result.haltedReason}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
