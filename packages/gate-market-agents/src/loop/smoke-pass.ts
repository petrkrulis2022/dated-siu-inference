import type { Adapter, AdapterParams } from "@touchstone/harness";
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
import { validateAgentContext } from "../pack/validate.js";
import type { ToolName } from "../tools/index.js";
import { buildTurnPrompt } from "./prompt.js";
import { ModelResponseParseError, parseModelResponse } from "./parse-tool-call.js";

/**
 * P4's real exit condition (spec §9.1): "ORCHESTRATOR alone, does the work itself... one job
 * passing G1-G5 with a real model in the loop." Checked against ORCHESTRATOR's own real granted
 * tool list (`skills/subcontract-and-settle.ts` §8.3) before this was written: `request_quote,
 * pay, submit_job, get_balances, get_print` — no claim/mint/redeem tools at all. P4 doesn't
 * involve the fSIU claim lifecycle (that's P5's subcontracting-via-claims scope) — it's purely
 * "does a real model correctly call submit_job and recognize a pass." This smoke pass therefore
 * needs no local devnet, no wallet, no chain — `submit_job`'s handler only touches
 * `deps.runGateHardeningChecks`, a real (no-model) sandboxed grading call already proven in WP-1.
 */
export interface SmokePassOptions {
  adapter: Adapter;
  modelString: string;
  prices: ModelPrices;
  maxOutputTokens: number;
  maxTurns: number;
  maxInferenceUsd: string;
  skillPackText: string;
  availableTools: readonly ToolName[];
  deps: RunnerDeps;
  jobId: string;
  /** Real args pre-supplied for a tool, substituted whenever the model calls that tool without
   * providing its own `args` (or provides exactly `"USE_PROVIDED_PAYLOAD"`). Exists because at
   * least one real tool's real payload (`submit_job`'s full gate/reference/adversarial fixture
   * set) can run to several KB — asking a model to transcribe that exactly, character for
   * character, tests JSON-retyping accuracy, not the tool-use reasoning this smoke pass is
   * actually meant to measure. The model still has to decide *which* tool to call and *when* —
   * it just doesn't have to retype a payload it was already given verbatim in its own prompt. */
  fixedArgsByTool?: Partial<Record<ToolName, unknown>>;
  onTurn?: (turn: TurnLog) => void;
}

export interface TurnLog {
  turn: number;
  promptChars: number;
  projectedUsd: string;
  realizedUsd: string;
  latencyMs: number;
  parsed: string;
}

export interface SmokePassResult {
  turnsUsed: number;
  totalRealizedUsd: string;
  done: boolean;
  summary?: string;
  haltedReason?: "ceiling" | "parse_error" | "max_turns" | "validation_failed";
  turnLogs: TurnLog[];
}

const AGENT_ID: AgentId = "ORCHESTRATOR";
const WINDOW_ID = "smoke-pass";
const ADAPTER_PARAMS: AdapterParams = { temperature: 0, max_tokens: 2000 };

/**
 * Fake, unused wallet material — `Runner`'s constructor calls `clientsFor(privateKeyHex, rpcUrl)`
 * (a lazy viem client, never dialed unless a tool actually makes a chain call — confirmed by
 * `runner.test.ts`'s own established pattern of using an undialed `rpcUrl`). `submit_job` never
 * touches `ctx.clients` at all, so this is real code exercised through its real path, just never
 * invoked for this particular tool.
 */
const UNUSED_PRIVATE_KEY = "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a";
const UNUSED_RPC_URL = "http://127.0.0.1:1";

export async function runSmokePass(options: SmokePassOptions): Promise<SmokePassResult> {
  const ceiling = new BudgetCeiling({
    "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    ORCHESTRATOR: {
      maxUsdcSpend: "0",
      maxInferenceTurns: options.maxTurns,
      maxInferenceUsd: options.maxInferenceUsd,
    },
    "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
  });

  const runner = new Runner({
    agentId: AGENT_ID,
    windowId: WINDOW_ID,
    privateKeyHex: UNUSED_PRIVATE_KEY,
    rpcUrl: UNUSED_RPC_URL,
    deps: options.deps,
    ceiling,
  });

  const turnLogs: TurnLog[] = [];
  let totalRealizedUsd = 0;

  for (let turn = 1; turn <= options.maxTurns; turn++) {
    if (ceiling.isHalted(AGENT_ID, WINDOW_ID)) {
      return {
        turnsUsed: turn - 1,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        done: false,
        haltedReason: "ceiling",
        turnLogs,
      };
    }

    const context = assembleContext(AGENT_ID, options.skillPackText, runner.toolCallRecords());

    try {
      validateAgentContext(context);
    } catch {
      return {
        turnsUsed: turn - 1,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        done: false,
        haltedReason: "validation_failed",
        turnLogs,
      };
    }

    const prompt = buildTurnPrompt(context, options.availableTools);
    const projectedUsd = projectedTurnCostUsd(
      Math.ceil(prompt.length / 4),
      options.maxOutputTokens,
      options.prices,
    );

    // Gates the real API call itself — the property that matters (spec §12.2a: projected, not
    // realized, spend). This is the *only* place this smoke pass records inference spend;
    // `Runner.callTool` below is deliberately called with no `projectedInferenceUsd` so it
    // doesn't check (and double-count) the same ceiling a second time — it still records the
    // turn itself, exactly once, via its own internal per-turn dedup.
    try {
      ceiling.recordInferenceSpend(AGENT_ID, WINDOW_ID, projectedUsd);
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        return {
          turnsUsed: turn - 1,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          done: false,
          haltedReason: "ceiling",
          turnLogs,
        };
      }
      throw err;
    }

    const adapterResult = await options.adapter(options.modelString, prompt, ADAPTER_PARAMS);

    const realizedUsd = realizedTurnCostUsd(
      adapterResult.usage.input,
      adapterResult.usage.output,
      options.prices,
    );
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
        return {
          turnsUsed: turn,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          done: false,
          haltedReason: "parse_error",
          turnLogs,
        };
      }
      throw err;
    }

    turnLogs.push({
      turn,
      promptChars: prompt.length,
      projectedUsd,
      realizedUsd,
      latencyMs: adapterResult.latency_ms,
      parsed: JSON.stringify(intent),
    });
    options.onTurn?.(turnLogs[turnLogs.length - 1]);

    if ("done" in intent) {
      return {
        turnsUsed: turn,
        totalRealizedUsd: totalRealizedUsd.toFixed(6),
        done: true,
        summary: intent.summary,
        turnLogs,
      };
    }

    try {
      // Runner.callTool's own internal recordTurn fires exactly once per new turn number,
      // regardless of whether the ceiling was also checked manually above for the dollar side —
      // this is the single place turns get counted.
      const args =
        (intent.args === undefined || intent.args === "USE_PROVIDED_PAYLOAD") &&
        options.fixedArgsByTool?.[intent.tool] !== undefined
          ? options.fixedArgsByTool[intent.tool]
          : intent.args;
      await runner.callTool(intent.tool, args, { turn, jobId: options.jobId });
    } catch (err) {
      if (err instanceof CeilingExceededError) {
        return {
          turnsUsed: turn,
          totalRealizedUsd: totalRealizedUsd.toFixed(6),
          done: false,
          haltedReason: "ceiling",
          turnLogs,
        };
      }
      throw err;
    }
  }

  return {
    turnsUsed: options.maxTurns,
    totalRealizedUsd: totalRealizedUsd.toFixed(6),
    done: false,
    haltedReason: "max_turns",
    turnLogs,
  };
}
