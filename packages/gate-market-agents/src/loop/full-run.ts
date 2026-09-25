import type { Adapter, AdapterParams } from "@touchstone/harness";
import type {
  GateHardeningJobInputs,
  GateHardeningResult,
  HeldOutInstance,
  ReferenceTaskInstance,
  Submission,
  TaskClass,
} from "@touchstone/task-pack-gate-hardening";
import { assembleContext } from "../context/assemble.js";
import { computeTimeToExpirySeconds } from "../context/expiry.js";
import {
  projectedTurnCostUsd,
  realizedTurnCostUsd,
  type ModelPrices,
} from "../budget/inference-cost.js";
import { ExperimentBudget, ExperimentCapExceededError } from "../budget/experiment-budget.js";
import { CeilingExceededError } from "../budget/ceiling.js";
import { gateResultsMatch } from "../gate/determinism.js";
import { Runner } from "../runner.js";
import type { RunnerDeps } from "../deps.js";
import type { AgentId } from "../identity/resolve.js";
import { ContextValidationError, validateAgentContext } from "../pack/validate.js";
import type { ToolName } from "../tools/index.js";
import { RunRecorder, type RunManifest } from "../run-recorder/recorder.js";
import { FrictionLogWriter, type FrictionLogEntry } from "../friction/log.js";
import { buildTurnPrompt } from "./prompt.js";
import { ModelResponseParseError, parseModelResponse, type FrictionReport } from "./parse-tool-call.js";

/**
 * WP-7's own general loop — P4 (one agent, one job) and P5 (six agents, several windows) are both
 * configurations of this same machinery, not separate code paths (this package's own WP-7 plan:
 * "P4 is this same loop... a real smoke test of the P5 machinery, not a fiction"). Per-agent
 * turn-order across a roster is genuinely new here; the per-turn body (assemble -> validate ->
 * prompt -> project cost -> charge ceiling -> call adapter -> parse -> call tool) is the same
 * proven shape `loop/gate-authoring-pass.ts` already uses for one agent, extended with real
 * friction-log writes, hold-decision `time_to_expiry` logging, and the gate-determinism check
 * (spec §9.3) around a `submit_job` call specifically.
 *
 * P5's own remaining, real gap — noted rather than silently worked around: this package has only
 * one fixed reference task per class (`CODE_REFERENCE`/`EXTRACT_REFERENCE`), not a generator for
 * distinct per-job content. A real P5 run reuses the same reference task across multiple job
 * attempts (varying quantity/timing/pricing, not task content) — adequate for a mechanism test
 * (do agents trade, settle, choose an asset), not a task-diversity benchmark. Building a real
 * per-job generator is separate, deferred work if P5 needs it.
 */
export interface RosterAgentConfig {
  agentId: AgentId;
  adapter: Adapter;
  modelString: string;
  prices: ModelPrices;
  skillPackText: string;
  availableTools: readonly ToolName[];
  privateKeyHex: string;
  rpcUrl: string;
  maxOutputTokens: number;
}

export interface JobEnvelope {
  jobId: string;
  taskClass: TaskClass;
  originalGate: import("@touchstone/task-pack-gate-hardening").GateSpec;
  referenceInstance: ReferenceTaskInstance;
  knownGoodSubmission: Submission;
  adversarialSubmissions: Submission[];
  heldOutInstances: readonly [HeldOutInstance, ...HeldOutInstance[]];
}

export interface FullRunWindowOptions {
  windowId: string;
  roster: readonly RosterAgentConfig[];
  /** One job at a time for now (P4: exactly one) — the roster takes turns against it until it
   * passes, a maxTurnsPerAgent ceiling is hit for everyone active, or the budget halts the run.
   * P5's real "6-10 jobs per window, alternating class" needs a queue of these, cycled through as
   * each is delivered or abandoned — not built here; see this file's own top comment. */
   job: JobEnvelope;
  maxTurnsPerAgent: number;
  budget: ExperimentBudget;
  deps: RunnerDeps;
  runsRoot: string;
  runId: string;
  manifest: RunManifest;
  onTurn?: (agentId: AgentId, log: TurnLog) => void;
}

export interface TurnLog {
  turn: number;
  promptChars: number;
  projectedUsd: string;
  realizedUsd: string;
  latencyMs: number;
  parsed: string;
  gateResult?: { passed: boolean; summary: string };
  quarantinedNonDeterministicGate?: boolean;
}

export interface FullRunWindowResult {
  passed: boolean;
  passedBy?: AgentId;
  totalRealizedUsd: string;
  turnsByAgent: Record<string, number>;
  haltedReason?: Record<string, "ceiling" | "parse_error" | "max_turns" | "validation_failed" | "voluntary_stop" | "experiment_halt">;
  turnLogsByAgent: Record<string, TurnLog[]>;
}

function summarizeGateResult(result: GateHardeningResult): string {
  if (result.passed) return "G1-G6 all passed";
  const checks = [
    ["G1", result.g1], ["G2", result.g2], ["G3", result.g3],
    ["G4", result.g4], ["G5", result.g5], ["G6", result.g6],
  ] as const;
  return checks.filter(([, c]) => !c.passed).map(([n, c]) => `${n} failed: ${c.reason}`).join("; ");
}

const DEFAULT_FRICTION: Required<FrictionReport> = {
  could_not_express: null,
  forced_conversion: false,
  conversion_reason: null,
  missing_information: null,
  decision_confidence: "medium",
};

/** Real, but only for the (currently empty) case where an agent holds a known claim past this
 * turn without redeeming it — P4's ORCHESTRATOR never mints/holds a claim (it authors gates
 * directly), so this always logs `time_to_expiry_seconds: null` for P4. Kept real and wired
 * rather than stubbed so a future P5 agent that does hold claims gets a genuine log, not a retrofit. */
async function holdTimeToExpiry(
  deps: RunnerDeps,
  heldTokenId: bigint | null,
): Promise<number | null> {
  if (heldTokenId === null) return null;
  const [{ windowTo }, now] = await Promise.all([
    deps.chainReader.claimWindow(heldTokenId),
    deps.chainReader.currentBlockTimestamp(),
  ]);
  return computeTimeToExpirySeconds(now, windowTo);
}

export async function runFullRunWindow(options: FullRunWindowOptions): Promise<FullRunWindowResult> {
  const recorder = new RunRecorder(options.runsRoot, options.runId, options.manifest);
  const friction = new FrictionLogWriter(options.runsRoot, options.runId);

  const runners = new Map(
    options.roster.map((agent) => [
      agent.agentId,
      new Runner({
        agentId: agent.agentId,
        windowId: options.windowId,
        privateKeyHex: agent.privateKeyHex,
        rpcUrl: agent.rpcUrl,
        deps: options.deps,
        ceiling: options.budget,
        allowedTools: agent.availableTools,
      }),
    ]),
  );

  const turnsByAgent: Record<string, number> = {};
  const haltedReason: FullRunWindowResult["haltedReason"] = {};
  const turnLogsByAgent: Record<string, TurnLog[]> = {};
  let totalRealizedUsd = 0;
  let passed = false;
  let passedBy: AgentId | undefined;

  for (const agent of options.roster) {
    turnsByAgent[agent.agentId] = 0;
    turnLogsByAgent[agent.agentId] = [];
  }

  const activeAgents = new Set(options.roster.map((a) => a.agentId));

  turnLoop: for (let turnCursor = 0; ; turnCursor++) {
    if (activeAgents.size === 0) break;
    const agent = options.roster[turnCursor % options.roster.length];
    if (!activeAgents.has(agent.agentId)) continue;

    const turn = turnsByAgent[agent.agentId] + 1;
    if (turn > options.maxTurnsPerAgent) {
      haltedReason[agent.agentId] = "max_turns";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const runner = runners.get(agent.agentId)!;

    if (options.budget.isHalted(agent.agentId, options.windowId)) {
      haltedReason[agent.agentId] = "ceiling";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const context = assembleContext(agent.agentId, agent.skillPackText, runner.toolCallRecords());
    recorder.recordContext(agent.agentId, turn, context);

    try {
      validateAgentContext(context);
      recorder.recordValidatorVerdict(agent.agentId, turn, null);
    } catch (err) {
      if (err instanceof ContextValidationError) recorder.recordValidatorVerdict(agent.agentId, turn, err);
      haltedReason[agent.agentId] = "validation_failed";
      activeAgents.delete(agent.agentId);
      continue;
    }

    const prompt = buildTurnPrompt(context, agent.availableTools);
    const projectedUsd = projectedTurnCostUsd(Math.ceil(prompt.length / 4), agent.maxOutputTokens, agent.prices);

    try {
      options.budget.recordInferenceSpend(agent.agentId, options.windowId, projectedUsd);
    } catch (err) {
      if (err instanceof ExperimentCapExceededError) {
        // A run/experiment-cap breach is the whole run's problem, not just this agent's — stop
        // scheduling everyone, not only the agent whose turn happened to trip it.
        for (const other of activeAgents) haltedReason[other] = "experiment_halt";
        break turnLoop;
      }
      if (err instanceof CeilingExceededError) {
        haltedReason[agent.agentId] = "ceiling";
        activeAgents.delete(agent.agentId);
        continue;
      }
      throw err;
    }

    turnsByAgent[agent.agentId] = turn;

    const adapterParams: AdapterParams = { temperature: 0, max_tokens: agent.maxOutputTokens };
    const adapterResult = await agent.adapter(agent.modelString, prompt, adapterParams);
    const realizedUsd = realizedTurnCostUsd(adapterResult.usage.input, adapterResult.usage.output, agent.prices);
    totalRealizedUsd += Number(realizedUsd);

    let intent;
    try {
      intent = parseModelResponse(adapterResult.text);
    } catch (err) {
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd,
        latencyMs: adapterResult.latency_ms,
        parsed: err instanceof Error ? err.message : String(err),
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      if (err instanceof ModelResponseParseError) {
        haltedReason[agent.agentId] = "parse_error";
        activeAgents.delete(agent.agentId);
        await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, undefined, null));
        continue;
      }
      throw err;
    }

    if ("done" in intent) {
      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd,
        latencyMs: adapterResult.latency_ms, parsed: JSON.stringify(intent),
      };
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);
      haltedReason[agent.agentId] = "voluntary_stop";
      activeAgents.delete(agent.agentId);
      await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, null));
      continue;
    }

    const args = buildToolArgs(intent.tool, intent.args, options.job);

    try {
      // Always the real, recorded call — allowlist-checked and ceiling-charged exactly once via
      // Runner, regardless of which tool this is. The determinism check (below) is an *extra*
      // verification alongside this, never a substitute for it — bypassing Runner to "check
      // twice instead of calling for real" would skip the allowlist check for this specific tool.
      const record = await runner.callTool(intent.tool, args, { turn, jobId: options.job.jobId });
      let quarantined = false;

      if (intent.tool === "submit_job") {
        // Runner's own call above is the real, recorded first invocation — one genuinely fresh
        // extra invocation, compared directly against it, is what actually checks determinism
        // (checkGateDeterminism's own two-thunk shape is for a caller with no first result yet).
        const secondOpinion = await options.deps.runGateHardeningChecks(
          args as unknown as GateHardeningJobInputs,
        );
        quarantined = !gateResultsMatch(record.result as GateHardeningResult, secondOpinion);
      }

      const gateResult = intent.tool === "submit_job" && !quarantined
        ? (record.result as GateHardeningResult)
        : undefined;

      const log: TurnLog = {
        turn, promptChars: prompt.length, projectedUsd, realizedUsd,
        latencyMs: adapterResult.latency_ms, parsed: JSON.stringify(intent),
        quarantinedNonDeterministicGate: quarantined || undefined,
      };
      if (gateResult) {
        log.gateResult = { passed: gateResult.passed, summary: summarizeGateResult(gateResult) };
      }
      turnLogsByAgent[agent.agentId].push(log);
      options.onTurn?.(agent.agentId, log);

      const timeToExpiry = await holdTimeToExpiry(options.deps, null);
      await friction.append(buildFrictionEntry(agent.agentId, turn, options.job.jobId, intent.friction, timeToExpiry));

      if (gateResult?.passed) {
        passed = true;
        passedBy = agent.agentId;
        break turnLoop;
      }
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        haltedReason[agent.agentId] = "ceiling";
        activeAgents.delete(agent.agentId);
        continue;
      }
      throw err;
    }
  }

  const result: FullRunWindowResult = {
    passed,
    passedBy,
    totalRealizedUsd: totalRealizedUsd.toFixed(6),
    turnsByAgent,
    haltedReason,
    turnLogsByAgent,
  };
  recorder.finalizeMetrics(result);
  return result;
}

function buildFrictionEntry(
  agentId: AgentId,
  turn: number,
  jobId: string,
  report: FrictionReport | undefined,
  timeToExpirySeconds: number | null,
): FrictionLogEntry {
  const merged = { ...DEFAULT_FRICTION, ...report };
  return {
    agent: agentId,
    turn,
    job_id: jobId,
    attempted: "turn taken",
    outcome: "recorded",
    could_not_express: merged.could_not_express,
    forced_conversion: merged.forced_conversion,
    conversion_reason: merged.conversion_reason,
    missing_information: merged.missing_information,
    decision_confidence: merged.decision_confidence,
    time_to_expiry_seconds: timeToExpirySeconds,
  };
}

function buildToolArgs(tool: ToolName, rawArgs: unknown, job: JobEnvelope): unknown {
  if (tool !== "submit_job") return rawArgs;
  const rawSource = (rawArgs as { source?: unknown } | undefined)?.source;
  return {
    taskClass: job.taskClass,
    originalGate: job.originalGate,
    hardenedGate: { taskClass: job.taskClass, source: typeof rawSource === "string" ? rawSource : "" },
    referenceInstance: job.referenceInstance,
    knownGoodSubmission: job.knownGoodSubmission,
    adversarialSubmissions: job.adversarialSubmissions,
    heldOutInstances: job.heldOutInstances,
  };
}
