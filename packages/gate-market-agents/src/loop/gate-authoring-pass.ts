import type { Adapter, AdapterParams } from "@touchstone/harness";
import type {
  GateHardeningResult,
  GateSpec,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  TaskClass,
} from "@touchstone/task-pack-gate-hardening";
import { assembleContext } from "../context/assemble.js";
import {
  projectedTurnCostUsd,
  realizedTurnCostUsd,
  type ModelPrices,
} from "../budget/inference-cost.js";
import { BudgetCeiling, CeilingExceededError } from "../budget/ceiling.js";
import { Runner } from "../runner.js";
import type { RunnerDeps } from "../deps.js";
import type { AgentId } from "../identity/resolve.js";
import { ContextValidationError, validateAgentContext } from "../pack/validate.js";
import type { ToolName } from "../tools/index.js";
import { RunRecorder, type RunManifest } from "../run-recorder/recorder.js";
import { buildTurnPrompt } from "./prompt.js";
import { ModelResponseParseError, parseModelResponse } from "./parse-tool-call.js";

/**
 * Measures real turns-to-completion for the task WP-7's 40-turns/window assumption actually
 * rests on: a worker *authoring* a gate, not just recognizing which pre-supplied tool to call
 * (that's all the P4 smoke pass measured — see this pass's own plan for why that's a floor, not
 * an estimate). The model here is given only the reference materials a real WORKER-EXTRACT would
 * have — the source document, the commercial intent, and the gate-authoring contract — and must
 * write the `hardenedGate.source` string itself. Everything else `submit_job` needs
 * (`taskClass`, the real `originalGate`, `referenceInstance`, `knownGoodSubmission`,
 * `adversarialSubmissions`) is fixed, real data merged in here — the model is never asked to
 * retype it, but it also never sees it as a "just call this" shortcut the way P4's sentinel did.
 */
export interface GateAuthoringPassOptions {
  adapter: Adapter;
  modelString: string;
  prices: ModelPrices;
  maxOutputTokens: number;
  maxTurns: number;
  maxInferenceUsd: string;
  agentId: AgentId;
  skillPackText: string;
  availableTools: readonly ToolName[];
  deps: RunnerDeps;
  jobId: string;
  taskClass: TaskClass;
  /** Everything `submit_job` needs except the gate the model is authoring — real data, fixed
   * for the whole pass. The model's own `args.source` is merged in as `hardenedGate.source`. */
  envelope: {
    originalGate: GateSpec;
    referenceInstance: ReferenceTaskInstance;
    knownGoodSubmission: Submission;
    adversarialSubmissions: Submission[];
    heldOutInstances: readonly [HeldOutInstance, ...HeldOutInstance[]];
  };
  runsRoot: string;
  runId: string;
  manifest: RunManifest;
  onTurn?: (turn: TurnLog) => void;
}

export interface TurnLog {
  turn: number;
  promptChars: number;
  projectedUsd: string;
  realizedUsd: string;
  latencyMs: number;
  parsed: string;
  /** Set only on a real submit_job attempt — the real per-check G1-G6 outcome, so a report can
   * distinguish "spent this turn reasoning/parsing" from "spent this turn on a failed attempt,
   * and here is exactly why it failed." */
  gateResult?: { passed: boolean; summary: string };
}

export interface GateAuthoringPassResult {
  turnsUsed: number;
  totalRealizedUsd: string;
  passed: boolean;
  haltedReason?: "ceiling" | "parse_error" | "max_turns" | "validation_failed" | "voluntary_stop";
  turnLogs: TurnLog[];
}

const WINDOW_ID = "gate-authoring-pass";

/** Same real-but-unused wallet material as loop/smoke-pass.ts — submit_job never touches
 * ctx.clients, so this is real code exercised through its real path, just never dialed. */
const UNUSED_PRIVATE_KEY = "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a";
const UNUSED_RPC_URL = "http://127.0.0.1:1";

function summarizeGateResult(result: GateHardeningResult): string {
  if (result.passed) return "G1-G6 all passed";
  const checks = [
    ["G1", result.g1],
    ["G2", result.g2],
    ["G3", result.g3],
    ["G4", result.g4],
    ["G5", result.g5],
    ["G6", result.g6],
  ] as const;
  return checks
    .filter(([, check]) => !check.passed)
    .map(([name, check]) => `${name} failed: ${check.reason}`)
    .join("; ");
}

export async function runGateAuthoringPass(options: GateAuthoringPassOptions): Promise<GateAuthoringPassResult> {
  const zeroLimits = { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" } as const;
  const ceiling = new BudgetCeiling({
    "ISSUER-A": zeroLimits,
    "ISSUER-B": zeroLimits,
    ORCHESTRATOR: zeroLimits,
    "WORKER-CODE": zeroLimits,
    "WORKER-EXTRACT": zeroLimits,
    HEDGER: zeroLimits,
    [options.agentId]: {
      maxUsdcSpend: "0",
      maxInferenceTurns: options.maxTurns,
      maxInferenceUsd: options.maxInferenceUsd,
    },
  });

  const runner = new Runner({
    agentId: options.agentId,
    windowId: WINDOW_ID,
    privateKeyHex: UNUSED_PRIVATE_KEY,
    rpcUrl: UNUSED_RPC_URL,
    deps: options.deps,
    ceiling,
    allowedTools: options.availableTools,
  });

  const recorder = new RunRecorder(options.runsRoot, options.runId, options.manifest);
  const finalize = (result: GateAuthoringPassResult): GateAuthoringPassResult => {
    recorder.finalizeMetrics(result);
    return result;
  };

  const turnLogs: TurnLog[] = [];
  let totalRealizedUsd = 0;

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    if (ceiling.isHalted(options.agentId, WINDOW_ID)) {
      return finalize({
        turnsUsed: turn - 1,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        passed: false,
        haltedReason: "ceiling",
        turnLogs,
      });
    }

    const context = assembleContext(options.agentId, options.skillPackText, runner.toolCallRecords());
    recorder.recordContext(options.agentId, turn, context);

    try {
      validateAgentContext(context);
      recorder.recordValidatorVerdict(options.agentId, turn, null);
    } catch (err) {
      if (err instanceof ContextValidationError) recorder.recordValidatorVerdict(options.agentId, turn, err);
      return finalize({
        turnsUsed: turn - 1,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        passed: false,
        haltedReason: "validation_failed",
        turnLogs,
      });
    }

    const prompt = buildTurnPrompt(context, options.availableTools);
    const projectedUsd = projectedTurnCostUsd(Math.ceil(prompt.length / 4), options.maxOutputTokens, options.prices);

    try {
      ceiling.recordInferenceSpend(options.agentId, WINDOW_ID, projectedUsd);
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        return finalize({
          turnsUsed: turn - 1,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          passed: false,
          haltedReason: "ceiling",
          turnLogs,
        });
      }
      throw err;
    }

    const adapterParams: AdapterParams = { temperature: 0, max_tokens: options.maxOutputTokens };
    const adapterResult = await options.adapter(options.modelString, prompt, adapterParams);
    const realizedUsd = realizedTurnCostUsd(adapterResult.usage.input, adapterResult.usage.output, options.prices);
    totalRealizedUsd += Number(realizedUsd);

    let intent;
    try {
      intent = parseModelResponse(adapterResult.text);
    } catch (err) {
      turnLogs.push({
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        latencyMs: adapterResult.latency_ms,
        parsed: err instanceof Error ? err.message : String(err),
      });
      options.onTurn?.(turnLogs[turnLogs.length - 1]);
      if (err instanceof ModelResponseParseError) {
        return finalize({
          turnsUsed: turn,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          passed: false,
          haltedReason: "parse_error",
          turnLogs,
        });
      }
      throw err;
    }

    if ("done" in intent) {
      turnLogs.push({
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        latencyMs: adapterResult.latency_ms,
        parsed: JSON.stringify(intent),
      });
      options.onTurn?.(turnLogs[turnLogs.length - 1]);
      // Voluntary stop is a halt path, not a success signal — see this file's own doc comment:
      // only a real submit_job result with passed === true (below) ever reports success.
      return finalize({
        turnsUsed: turn,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        passed: false,
        haltedReason: "voluntary_stop",
        turnLogs,
      });
    }

    const rawSource = (intent.args as { source?: unknown } | undefined)?.source;
    const hardenedGate: GateSpec = {
      taskClass: options.taskClass,
      source: typeof rawSource === "string" ? rawSource : "",
    };
    const args = {
      taskClass: options.taskClass,
      originalGate: options.envelope.originalGate,
      hardenedGate,
      referenceInstance: options.envelope.referenceInstance,
      knownGoodSubmission: options.envelope.knownGoodSubmission,
      adversarialSubmissions: options.envelope.adversarialSubmissions,
      heldOutInstances: options.envelope.heldOutInstances,
    };

    try {
      const record = await runner.callTool(intent.tool, args, { turn, jobId: options.jobId });
      const gateResult = record.result as GateHardeningResult;
      const gateResultSummary = summarizeGateResult(gateResult);

      turnLogs.push({
        turn,
        promptChars: prompt.length,
        projectedUsd,
        realizedUsd,
        latencyMs: adapterResult.latency_ms,
        parsed: JSON.stringify(intent),
        gateResult: { passed: gateResult.passed, summary: gateResultSummary },
      });
      options.onTurn?.(turnLogs[turnLogs.length - 1]);

      // Loop-detected success, not model-self-reported — the real property that matters here.
      if (gateResult.passed) {
        return finalize({
          turnsUsed: turn,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          passed: true,
          turnLogs,
        });
      }
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        return finalize({
          turnsUsed: turn,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          passed: false,
          haltedReason: "ceiling",
          turnLogs,
        });
      }
      throw err;
    }
  }

  return finalize({
    turnsUsed: options.maxTurns,
    totalRealizedUsd: totalRealizedUsd.toFixed(6),
    passed: false,
    haltedReason: "max_turns",
    turnLogs,
  });
}
