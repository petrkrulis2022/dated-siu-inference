import { createAdapterFor, loadApiKeysFromEnv } from "@touchstone/harness";
import {
  runGateHardeningChecks,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_3_HARDENED,
  CODE_REFERENCE,
  CODE_KNOWN_GOOD,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_STUBBED,
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
} from "@touchstone/task-pack-gate-hardening";
import { buildCommonPack } from "../pack/build.js";
import { SUBCONTRACT_AND_SETTLE } from "../skills/subcontract-and-settle.js";
import type { ModelPrices } from "../budget/inference-cost.js";
import type { RunnerDeps } from "../deps.js";
import { runSmokePass } from "../loop/smoke-pass.js";

// gpt-5.1's real registry entry (data/registry/models.json) and real current price
// (data/registry/price-snapshot-merged-2026-09-22...json) — this session's own cost projection
// already assigned ORCHESTRATOR here. Not re-read from the live files at runtime: a one-time
// manual smoke pass, not a production path that needs to track price drift automatically.
const MODEL_STRING = "gpt-5.1";
const PRICES: ModelPrices = { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" };

const MAX_TURNS = 20;
const MAX_INFERENCE_USD = "0.50";

/**
 * P4's real exit condition (spec §9.1) needs no claim/mint/redeem tools — see `loop/smoke-pass.ts`'s
 * own doc comment for why. `runGateHardeningChecks` is the real, no-model, already-proven-in-WP-1
 * sandboxed G1-G5 executor; everything else in `RunnerDeps` is unused by `submit_job` and is
 * stubbed accordingly rather than wired to a real chain this smoke pass doesn't need.
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
      throw new Error("get_print is not exercised by this smoke pass.");
    },
    isReconciled: async () => false,
  };
}

async function main(): Promise<void> {
  const apiKeys = loadApiKeysFromEnv();
  const adapter = createAdapterFor({ provider: "openai", host: "openai" }, apiKeys);

  const commonPack = buildCommonPack({
    agentId: "ORCHESTRATOR",
    walletAddress: "0x0000000000000000000000000000000000dead",
    erc8004Id: "erc8004:0x0000000000000000000000000000000000dead",
    usdcBalanceUsd: "0.00",
    claimBalancesSummary: "not applicable — P4's smoke pass doesn't exercise claims",
    classes: [],
    printsByClass: {},
  });

  // The real, complete submit_job payload — given directly, not reconstructed from memory. This
  // measures whether the model correctly wraps a real payload in the right tool call, not
  // whether it can perfectly transcribe several KB of JSON from a description without error.
  const submitJobArgs = {
    taskClass: "code" as const,
    originalGate: CODE_GATE_1_TRIVIAL,
    hardenedGate: CODE_GATE_3_HARDENED,
    referenceInstance: CODE_REFERENCE,
    knownGoodSubmission: CODE_KNOWN_GOOD,
    adversarialSubmissions: [
      CODE_ADVERSARIAL_ORIGINAL_BUG,
      CODE_ADVERSARIAL_HARDCODED,
      CODE_ADVERSARIAL_STUBBED,
      CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
    ],
  };

  const jobDescription = `
YOUR JOB THIS RUN
  Harden the "code" class gate. You are working alone this run — no subcontracting (P4: single
  agent). The real gate-hardening payload for this job (candidate gate, hardened gate, reference
  task, known-good submission, adversarial submissions) is already prepared for you — you do not
  need to write or transcribe it. To submit it, respond with exactly:
  {"tool": "submit_job", "args": "USE_PROVIDED_PAYLOAD"}
  If every one of G1-G5 comes back passed, respond done with a short summary.
`;

  const skillPackText = `${SUBCONTRACT_AND_SETTLE}\n\n${commonPack}\n\n${jobDescription}`;

  console.log(`Starting P4 smoke pass — ORCHESTRATOR alone, model=${MODEL_STRING}`);
  console.log(`Bounds: maxTurns=${MAX_TURNS}, maxInferenceUsd=$${MAX_INFERENCE_USD}\n`);

  const result = await runSmokePass({
    adapter,
    modelString: MODEL_STRING,
    prices: PRICES,
    maxOutputTokens: 500,
    maxTurns: MAX_TURNS,
    maxInferenceUsd: MAX_INFERENCE_USD,
    skillPackText,
    availableTools: ["submit_job", "get_balances"],
    deps: buildDeps(),
    jobId: "p4-smoke-pass",
    fixedArgsByTool: { submit_job: submitJobArgs },
    onTurn: (turn) => {
      console.log(
        `Turn ${turn.turn}: prompt=${turn.promptChars} chars, projected=$${turn.projectedUsd}, ` +
          `realized=$${turn.realizedUsd}, ${turn.latencyMs}ms -> ${turn.parsed.slice(0, 200)}`,
      );
    },
  });

  console.log("\n=== RESULT ===");
  console.log(`turnsUsed: ${result.turnsUsed}`);
  console.log(`totalRealizedUsd: $${result.totalRealizedUsd}`);
  console.log(`done: ${result.done}`);
  if (result.summary) console.log(`summary: ${result.summary}`);
  if (result.haltedReason) console.log(`haltedReason: ${result.haltedReason}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
