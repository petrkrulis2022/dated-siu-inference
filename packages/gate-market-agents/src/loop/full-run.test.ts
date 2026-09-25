import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { Print } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { loadSkill } from "../skills/registry.js";
import { runFullRunWindow, type JobEnvelope, type RosterAgentConfig } from "./full-run.js";

const PRICES = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };

const PASS: GateHardeningResult = {
  g1: { passed: true, reason: "ok" }, g2: { passed: true, reason: "ok" },
  g3: { passed: true, reason: "ok" }, g4: { passed: true, reason: "ok" },
  g5: { passed: true, reason: "ok" }, g6: { passed: true, reason: "ok" },
  passed: true,
};

function failResult(reason: string): GateHardeningResult {
  return {
    g1: { passed: true, reason: "ok" }, g2: { passed: false, reason },
    g3: { passed: true, reason: "ok" }, g4: { passed: true, reason: "ok" },
    g5: { passed: true, reason: "ok" }, g6: { passed: true, reason: "ok" },
    passed: false,
  };
}

function fakeDeps(runGateHardeningChecks: RunnerDeps["runGateHardeningChecks"]): RunnerDeps {
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
      network: { name: "test", chainId: 0 },
      usdc: { address: "0x0" }, capacityBond: { address: "0x0" },
      claimRouter: { address: "0x0" }, workClaim: { address: "0x0" },
    },
    escrowAddress: "0x0",
    runGateHardeningChecks,
    loadPrint: async () => ({ print_id: "2026-09-25" }) as unknown as Print,
    isReconciled: async () => false,
  };
}

function scriptedAdapter(sources: string[]): Adapter {
  let call = 0;
  return async (): Promise<AdapterResult> => {
    const source = sources[Math.min(call, sources.length - 1)];
    call++;
    return {
      text: JSON.stringify({ tool: "submit_job", args: { source } }),
      usage: { input: 500, output: 300, cached_input: 0, reasoning: 0 },
      latency_ms: 1, raw: {}, deviations: [],
    };
  };
}

const JOB: JobEnvelope = {
  jobId: "full-run-test-job",
  taskClass: "extract",
  originalGate: { taskClass: "extract", source: "export async function gate(){ return {accept:false,reason:'trivial'}; }" },
  referenceInstance: { taskClass: "extract", files: {} },
  knownGoodSubmission: { files: { "answer.json": "{}" } },
  adversarialSubmissions: [],
  heldOutInstances: [
    { referenceInstance: { taskClass: "extract", files: {} }, knownGoodSubmission: { files: { "answer.json": "{}" } }, adversarialSubmissions: [] },
  ],
};

const MANIFEST: RunManifest = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/extract@0.0.0",
  agentConfigs: { ORCHESTRATOR: { reasoningModel: "gpt-5.1" } },
  seed: "full-run-test-seed",
};

function orchestratorConfig(adapter: Adapter): RosterAgentConfig {
  return {
    agentId: "ORCHESTRATOR",
    adapter,
    modelString: "gpt-5.1",
    prices: PRICES,
    skillPackText: `${loadSkill("subcontract-and-settle").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}`,
    availableTools: ["submit_job"] as const,
    privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
    rpcUrl: "http://127.0.0.1:1",
    maxOutputTokens: 3000,
  };
}

function generousBudget(ledgerPath: string): ExperimentBudget {
  const ceiling = new BudgetCeiling({
    "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 40, maxInferenceUsd: "2" },
    "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
  });
  return new ExperimentBudget({ ceiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath });
}

describe("runFullRunWindow — P4 shape: one agent, one job", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-test-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("succeeds the instant a real, confirmed-deterministic G1-G6 result says passed", async () => {
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 40,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot, runId: "run-1", manifest: MANIFEST,
    });

    expect(result.passed).toBe(true);
    expect(result.passedBy).toBe("ORCHESTRATOR");
    expect(result.turnsByAgent.ORCHESTRATOR).toBe(1);
  });

  it("quarantines a non-deterministic gate rather than reporting a pass — never counts it", async () => {
    let call = 0;
    // Two real invocations of the same args genuinely disagree — the exact property this check
    // exists to catch, not simulated any other way.
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => (call++ === 0 ? PASS : failResult("flaked"))),
      runsRoot, runId: "run-2", manifest: MANIFEST,
    });

    expect(result.passed).toBe(false);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].quarantinedNonDeterministicGate).toBe(true);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].gateResult).toBeUndefined();
  });

  it("halts at maxTurnsPerAgent if the gate never passes", async () => {
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 3,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot, runId: "run-3", manifest: MANIFEST,
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("max_turns");
    expect(result.turnsByAgent.ORCHESTRATOR).toBe(3);
  });

  it("halts the whole run on an experiment-wide cap breach, not just one agent", async () => {
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 40, maxInferenceUsd: "1000" },
      "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    });
    const tightBudget = new ExperimentBudget({ ceiling, runCapUsd: "1000", experimentCapUsd: "0.000001", ledgerPath });

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 40,
      budget: tightBudget,
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot, runId: "run-4", manifest: MANIFEST,
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("experiment_halt");
  });

  it("writes a real friction-log entry every turn, including the model's own reported friction", async () => {
    const adapter: Adapter = async () => ({
      text: JSON.stringify({
        tool: "submit_job",
        args: { source: "export async function gate(){ return {accept:false,reason:'x'}; }" },
        friction: { missing_information: "didn't know the other issuer's rate", decision_confidence: "low" },
      }),
      usage: { input: 500, output: 300, cached_input: 0, reasoning: 0 },
      latency_ms: 1, raw: {}, deviations: [],
    });

    await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(adapter)],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot, runId: "run-5", manifest: MANIFEST,
    });

    const lines = (await readFile(path.join(runsRoot, "run-5", "friction", "friction-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      agent: "ORCHESTRATOR",
      job_id: "full-run-test-job",
      missing_information: "didn't know the other issuer's rate",
      decision_confidence: "low",
      forced_conversion: false,
    });

    const caveat = JSON.parse(await readFile(path.join(runsRoot, "run-5", "friction", "caveat.json"), "utf-8"));
    expect(caveat.mechanism_caveat).toBeTruthy();
  });

  it("defaults conservatively when the model reports no friction at all — never invents any", async () => {
    await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot, runId: "run-6", manifest: MANIFEST,
    });

    const lines = (await readFile(path.join(runsRoot, "run-6", "friction", "friction-log.jsonl"), "utf-8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({
      could_not_express: null,
      forced_conversion: false,
      conversion_reason: null,
      missing_information: null,
      decision_confidence: "medium",
    });
  });
});
