import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { G1ToG5Result } from "@touchstone/task-pack-gate-hardening";
import type { Print } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { loadSkill } from "../skills/registry.js";
import { runGateAuthoringPass, type GateAuthoringPassOptions } from "./gate-authoring-pass.js";

const PRICES = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" }; // gemini-3.1-pro-preview's real registry price

const PASS: G1ToG5Result = {
  g1: { passed: true, reason: "ok" },
  g2: { passed: true, reason: "ok" },
  g3: { passed: true, reason: "ok" },
  g4: { passed: true, reason: "ok" },
  g5: { passed: true, reason: "ok" },
  passed: true,
};

function failResult(reason: string): G1ToG5Result {
  return {
    g1: { passed: true, reason: "ok" },
    g2: { passed: false, reason },
    g3: { passed: true, reason: "ok" },
    g4: { passed: true, reason: "ok" },
    g5: { passed: true, reason: "ok" },
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
      usdc: { address: "0x0" },
      capacityBond: { address: "0x0" },
      claimRouter: { address: "0x0" },
      workClaim: { address: "0x0" },
    },
    escrowAddress: "0x0",
    runGateHardeningChecks,
    loadPrint: async () => ({ print_id: "2026-09-23" }) as unknown as Print,
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
      latency_ms: 1,
      raw: {},
      deviations: [],
    };
  };
}

const MANIFEST: RunManifest = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/extract@0.0.0",
  agentConfigs: { "WORKER-EXTRACT": { reasoningModel: "gemini-3.1-pro-preview" } },
  seed: "gate-authoring-pass-test-seed",
};

function baseOptions(
  runsRoot: string,
  runGateHardeningChecks: RunnerDeps["runGateHardeningChecks"],
): Omit<GateAuthoringPassOptions, "adapter"> {
  return {
    modelString: "gemini-3.1-pro-preview",
    prices: PRICES,
    maxOutputTokens: 3000,
    maxTurns: 40,
    maxInferenceUsd: "2",
    agentId: "WORKER-EXTRACT",
    // A real skill file + the real canonical asset description — validateAgentContext (WP-6)
    // correctly rejects anything less, exactly as it's designed to.
    skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}`,
    availableTools: ["submit_job"] as const,
    deps: fakeDeps(runGateHardeningChecks),
    jobId: "gate-authoring-test-job",
    taskClass: "extract",
    envelope: {
      originalGate: { taskClass: "extract", source: "export async function gate(){ return {accept:false,reason:'trivial'}; }" },
      referenceInstance: { taskClass: "extract", files: {} },
      knownGoodSubmission: { files: { "answer.json": "{}" } },
      adversarialSubmissions: [],
    },
    runsRoot,
    runId: "gate-authoring-test-run",
    manifest: MANIFEST,
  };
}

describe("runGateAuthoringPass", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-authoring-pass-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("succeeds the instant the real G1-G5 result says passed — loop-detected, not model-claimed", async () => {
    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, async () => PASS),
      adapter: scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
    });

    expect(result.passed).toBe(true);
    expect(result.turnsUsed).toBe(1);
    expect(result.haltedReason).toBeUndefined();
    expect(result.turnLogs[0].gateResult).toEqual({ passed: true, summary: "G1-G5 all passed" });
  });

  it("retries across multiple failing attempts before eventually succeeding", async () => {
    let call = 0;
    const runGateHardeningChecks = async (): Promise<G1ToG5Result> => {
      call++;
      return call < 3 ? failResult(`attempt ${call} still wrong`) : PASS;
    };

    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, runGateHardeningChecks),
      adapter: scriptedAdapter([
        "export async function gate(){ return {accept:false,reason:'v1'}; }",
        "export async function gate(){ return {accept:false,reason:'v2'}; }",
        "export async function gate(){ return {accept:true,reason:'v3'}; }",
      ]),
    });

    expect(result.passed).toBe(true);
    expect(result.turnsUsed).toBe(3);
    expect(result.turnLogs[0].gateResult?.passed).toBe(false);
    expect(result.turnLogs[1].gateResult?.passed).toBe(false);
    expect(result.turnLogs[2].gateResult?.passed).toBe(true);
  });

  it("halts at exactly maxTurns if the gate never passes", async () => {
    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, async () => failResult("never right")),
      maxTurns: 4,
      adapter: scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]),
    });

    expect(result.passed).toBe(false);
    expect(result.turnsUsed).toBe(4);
    expect(result.haltedReason).toBe("max_turns");
  });

  it("halts on the real dollar ceiling before it would be exceeded", async () => {
    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, async () => failResult("never right")),
      maxInferenceUsd: "0.01",
      adapter: scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]),
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason).toBe("ceiling");
    expect(result.turnsUsed).toBeLessThan(40);
  });

  it("halts with parse_error on an unparseable response", async () => {
    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, async () => PASS),
      adapter: async () => ({
        text: "I'm thinking about it.",
        usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason).toBe("parse_error");
  });

  it("halts on voluntary stop without ever reporting success, even if the model claims done", async () => {
    const result = await runGateAuthoringPass({
      ...baseOptions(runsRoot, async () => PASS),
      adapter: async () => ({
        text: JSON.stringify({ done: true, summary: "I believe this is correct" }),
        usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      }),
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason).toBe("voluntary_stop");
  });

  it("never lets the model's own args override the fixed envelope's taskClass or fixtures", async () => {
    let capturedArgs: unknown;
    const runGateHardeningChecks = async (args: unknown): Promise<G1ToG5Result> => {
      capturedArgs = args;
      return PASS;
    };

    await runGateAuthoringPass({
      ...baseOptions(runsRoot, runGateHardeningChecks),
      adapter: async () => ({
        text: JSON.stringify({
          tool: "submit_job",
          args: {
            source: "export async function gate(){ return {accept:true,reason:'ok'}; }",
            taskClass: "code", // a bogus attempt to override the fixed envelope
            adversarialSubmissions: [{ files: { hacked: "true" } }],
          },
        }),
        usage: { input: 500, output: 300, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      }),
    });

    expect((capturedArgs as { taskClass: string }).taskClass).toBe("extract");
    expect((capturedArgs as { adversarialSubmissions: unknown[] }).adversarialSubmissions).toEqual([]);
  });
});
