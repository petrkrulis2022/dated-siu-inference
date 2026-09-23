import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
import {
  runGateHardeningChecks,
  EXTRACT_GATE_1_TRIVIAL,
  EXTRACT_REFERENCE,
  EXTRACT_KNOWN_GOOD,
  PLAUSIBLE_FABRICATION,
  NULL_SEMANTICS_ADVERSARIAL,
  FIELD_ORDER_GAMING,
  EXTRACT_COMMERCIAL_INTENT,
  EXTRACT_HELD_OUT_INSTANCES,
} from "@touchstone/task-pack-gate-hardening";
import { loadSkill } from "../skills/registry.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import type { ModelPrices } from "../budget/inference-cost.js";
import type { RunnerDeps } from "../deps.js";
import { runGateAuthoringPass } from "../loop/gate-authoring-pass.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { RUNS_ROOT } from "./runs-root.js";

// gemini-3.1-pro-preview's real registry entry (data/registry/models.json) and real current
// price (data/registry/price-snapshot-merged-2026-09-23...json) — WORKER-EXTRACT's already-
// agreed frontier-tier model from this session's earlier model-assignment discussion.
const MODEL_STRING = "gemini-3.1-pro-preview";
const PRICES: ModelPrices = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };

const MAX_TURNS = 40;
const MAX_INFERENCE_USD = "2";

/**
 * submit_job never touches ctx.clients (same as the P4 smoke pass) — real deps are only the
 * real, no-model, sandboxed G1-G6 executor; everything chain-shaped is stubbed/unused.
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
  const adapter = createAdapterFor({ provider: "google", host: "google" }, apiKeys);

  const workerSkill = loadSkill("quote-and-deliver");

  // Real reference material only — the source document itself, never the known-good submission
  // (which would hand the model its own literal answer) and never the original/trivial gate or
  // the adversarial submissions (see this pass's own plan: measuring general robustness
  // reasoning, not pattern-matching against fixtures a real WP-7 worker wouldn't see either).
  const sourceDocument = EXTRACT_REFERENCE.files["source-document.txt"];

  const jobDescription = `
YOUR JOB THIS RUN
  You are WORKER-EXTRACT, working alone (no subcontracting, no other agents in this run). Author
  a gate that validates a structured extraction of the source document below against the
  commercial intent — from scratch. No candidate gate, no example submission, and no adversarial
  cases are given to you; none exist yet for you to see.

SOURCE DOCUMENT (the real document a submission must be extracted from):
---
${sourceDocument}---

COMMERCIAL INTENT:
  ${EXTRACT_COMMERCIAL_INTENT}

REQUIRED FIELDS your gate must check, exactly: invoice_number, vendor, total_amount, currency,
due_date.

HOW A GATE IS AUTHORED (technical contract, not a solution):
  Your gate's source is a JavaScript ES module. It must export:
    export async function gate({ referenceDir, submissionDir }) {
      // referenceDir contains the real source document for THIS grading run, at
      // referenceDir + "/source-document.txt" — read it every time you are called.
      // submissionDir contains the submission being graded, at
      // submissionDir + "/answer.json" — read and parse it.
      // Derive the correct values from referenceDir's document, compare them to the
      // submission, and return { accept: <boolean>, reason: <string> }.
    }
  It runs inside a sandbox with only node:fs available — no network, no other imports beyond
  node builtins.

  IMPORTANT — read this carefully: your gate will be graded not only against the document shown
  to you above, but also against several other real invoices you have never seen, each with its
  own submission to grade. A gate that hard-codes this run's specific values (the literal string
  "INV-4471", "128.50", etc.) will pass grading against this document and then fail on every
  other one — it will never even be asked to grade this exact document more than once. Your gate
  must derive the expected values from referenceDir's document at the moment it runs, every time,
  not from values you compute once now and embed as literals. This is not a matter of style: a
  gate that cannot do this is not a verifier and is worthless for its real purpose.

TO SUBMIT YOUR GATE, respond with exactly:
  {"tool": "submit_job", "args": {"source": "<your full gate module source as a JSON string>"}}
  The source must be valid JavaScript, correctly escaped as one JSON string value (escape every
  newline as \\n and every double-quote as \\"). If your submitted gate does not pass every
  check, you will see exactly which check failed and why on your next turn — revise and
  resubmit within your turn budget.
`;

  const skillPackText = `${workerSkill.promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}\n\n${jobDescription}`;

  const runId = `extract-gate-authoring-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const manifest: RunManifest = {
    benchVersion: "0.0.0",
    packVersion: "gate-hardening/extract@0.0.0",
    agentConfigs: { "WORKER-EXTRACT": { reasoningModel: MODEL_STRING } },
    seed: "extract-gate-authoring-pass — no seeded randomness in this loop",
  };

  console.log(`Starting single-agent gate-authoring pass — WORKER-EXTRACT alone, model=${MODEL_STRING}`);
  console.log(`Bounds: maxTurns=${MAX_TURNS}, maxInferenceUsd=$${MAX_INFERENCE_USD}`);
  console.log(`Run recorded to: ${RUNS_ROOT}/${runId}\n`);

  const result = await runGateAuthoringPass({
    adapter,
    modelString: MODEL_STRING,
    prices: PRICES,
    maxOutputTokens: 3000,
    maxTurns: MAX_TURNS,
    maxInferenceUsd: MAX_INFERENCE_USD,
    agentId: "WORKER-EXTRACT",
    skillPackText,
    availableTools: ["submit_job"],
    deps: buildDeps(),
    jobId: "extract-gate-authoring-pass",
    taskClass: "extract",
    envelope: {
      originalGate: EXTRACT_GATE_1_TRIVIAL,
      referenceInstance: EXTRACT_REFERENCE,
      knownGoodSubmission: EXTRACT_KNOWN_GOOD,
      adversarialSubmissions: [PLAUSIBLE_FABRICATION, NULL_SEMANTICS_ADVERSARIAL, FIELD_ORDER_GAMING],
      heldOutInstances: EXTRACT_HELD_OUT_INSTANCES,
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
