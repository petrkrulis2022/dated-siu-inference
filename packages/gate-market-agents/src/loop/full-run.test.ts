import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress, recoverTypedDataAddress, type Hex } from "viem";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { GateHardeningResult } from "@touchstone/task-pack-gate-hardening";
import type { Print } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { loadSkill } from "../skills/registry.js";
import { QuoteBoard } from "./quote-board.js";
import {
  buildToolArgs,
  runFullRunWindow,
  type BuildToolArgsContext,
  type JobEnvelope,
  type MintContext,
  type RosterAgentConfig,
} from "./full-run.js";

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
    address: "0x0000000000000000000000000000000000000001",
    erc8004Id: "erc8004:0x0000000000000000000000000000000000000001",
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

describe("buildToolArgs", () => {
  const FAKE_DEPLOYMENT: RunnerDeps["deployment"] = {
    network: { name: "test", chainId: 84532 },
    usdc: { address: "0x0" },
    capacityBond: { address: "0x0" },
    claimRouter: { address: "0x0" },
    workClaim: { address: getAddress(`0x${"0".repeat(36)}cafe` as Hex) },
  };
  const PUBLISHER_PK: Hex = "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a";

  function baseCtx(overrides: Partial<BuildToolArgsContext> = {}): BuildToolArgsContext {
    return {
      job: JOB,
      board: new QuoteBoard(),
      agentAddressByAgentId: {},
      deployment: FAKE_DEPLOYMENT,
      windowFrom: 1_800_000_000n,
      windowTo: 1_800_003_600n,
      ...overrides,
    };
  }

  it("mint_claim: splices a real EIP-712 attestation that recovers to the real publisher key", async () => {
    const mintContext: MintContext = {
      publisherPrivateKeyHex: PUBLISHER_PK,
      printId: "2026-09-25",
      nanoUsdPerSiu: 10_700_000n,
      validitySeconds: 3600n,
    };
    const args = (await buildToolArgs("mint_claim", { quantity: "500" }, baseCtx({ mintContext }))) as {
      classId: string; quantity: string; windowFrom: number; windowTo: number;
      printId: string; nanoUsdPerSiu: string; validUntil: string; signature: Hex;
    };

    expect(args.quantity).toBe("500"); // the model's own real economic choice, untouched
    expect(args.windowFrom).toBe(1_800_000_000);
    expect(args.windowTo).toBe(1_800_003_600);
    expect(args.printId).toBe("2026-09-25");
    expect(args.nanoUsdPerSiu).toBe("10700000");

    const recovered = await recoverTypedDataAddress({
      domain: { name: "Touchstone Rate Attestation", version: "1", chainId: 84532, verifyingContract: FAKE_DEPLOYMENT.workClaim.address as Hex },
      types: { RateAttestation: [
        { name: "printId", type: "string" }, { name: "nanoUsdPerSiu", type: "uint256" }, { name: "validUntil", type: "uint64" },
      ] },
      primaryType: "RateAttestation",
      message: { printId: args.printId, nanoUsdPerSiu: BigInt(args.nanoUsdPerSiu), validUntil: BigInt(args.validUntil) },
      signature: args.signature,
    });
    expect(recovered.toLowerCase()).toBe(privateKeyToAccount(PUBLISHER_PK).address.toLowerCase());
  });

  it("mint_claim: refuses when this window has no mintContext at all", async () => {
    await expect(buildToolArgs("mint_claim", { quantity: "500" }, baseCtx())).rejects.toThrow(
      /no mintContext/,
    );
  });

  it("transfer_claim: resolves a symbolic agentId to the roster's own real address", async () => {
    const args = await buildToolArgs(
      "transfer_claim",
      { agentId: "WORKER-CODE", tokenId: "1", quantity: "10" },
      baseCtx({ agentAddressByAgentId: { "WORKER-CODE": "0xabc0000000000000000000000000000000dead" } }),
    );
    expect(args).toEqual({ to: "0xabc0000000000000000000000000000000dead", tokenId: "1", quantity: "10" });
  });

  it("transfer_claim: honours a literal 'to' address unchanged when given instead", async () => {
    const args = await buildToolArgs(
      "transfer_claim",
      { to: "0x1111111111111111111111111111111111111e", tokenId: "1", quantity: "10" },
      baseCtx(),
    );
    expect(args).toEqual({ to: "0x1111111111111111111111111111111111111e", tokenId: "1", quantity: "10" });
  });

  it("transfer_claim: refuses a symbolic agentId with no known address, rather than sending nowhere", async () => {
    await expect(
      buildToolArgs("transfer_claim", { agentId: "HEDGER", tokenId: "1", quantity: "10" }, baseCtx()),
    ).rejects.toThrow(/no known address/);
  });

  it("issue_quote: uses the board's own stored body for a real open request, never the model's own reconstruction", async () => {
    const board = new QuoteBoard();
    const realBody = {
      schema_version: "2.0", siu: "10", pattern: "fixed" as const, model: "test",
      rate_usd_per_siu: "0.05", amount_usd_max: "0.5", index_version: "SIU-2026a",
      print_id: "2026-09-25", print_hash: "0xabc", seller_id: "erc8004:0xWORKERCODE",
      expiry: "2026-09-26T00:00:00Z",
      settlement: [{ asset: "usdc" as const, address: "0x0", amount_max: "500000" }],
    };
    const request = board.postRequest("ORCHESTRATOR", realBody);

    const args = await buildToolArgs(
      "issue_quote",
      { requestId: request.requestId, siu: "999999" }, // a bogus attempt to override the real body
      baseCtx({ board }),
    );
    expect(args).toEqual(realBody);
    expect((args as { siu: string }).siu).toBe("10");
  });

  it("issue_quote: refuses an unknown requestId rather than signing something unasked", async () => {
    await expect(
      buildToolArgs("issue_quote", { requestId: "qr-nonexistent" }, baseCtx()),
    ).rejects.toThrow(/no open request/);
  });
});

describe("runFullRunWindow — the quote board makes a real two-agent negotiation possible", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-board-test-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("ORCHESTRATOR's request becomes visible to WORKER-CODE, and WORKER-CODE's signed quote becomes visible back", async () => {
    // Real round-robin order for roster [ORCHESTRATOR, WORKER-CODE]: ORCHESTRATOR's own turn 1
    // runs first and posts the request — so WORKER-CODE's very first turn already sees it, and
    // ORCHESTRATOR's own turn 2 is the first point it could see WORKER-CODE's answer.
    let orchestratorTurn = 0;
    const orchestratorAdapter: Adapter = async () => {
      orchestratorTurn++;
      if (orchestratorTurn === 1) {
        return {
          text: JSON.stringify({
            tool: "request_quote",
            args: {
              siu: "10", model: "claude-sonnet-5", rateUsdPerSiu: "0.05", indexVersion: "SIU-2026a",
              printId: "2026-09-25", printHash: "0xabc", sellerId: "erc8004:0xWORKERCODE",
              chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
            },
          }),
          usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 }, latency_ms: 1, raw: {}, deviations: [],
        };
      }
      return {
        text: JSON.stringify({ done: true, summary: "saw the answered quote, stopping here for this test" }),
        usage: { input: 50, output: 10, cached_input: 0, reasoning: 0 }, latency_ms: 1, raw: {}, deviations: [],
      };
    };
    const workerAdapter: Adapter = async () => ({
      text: JSON.stringify({ tool: "issue_quote", args: { requestId: "qr-1" } }),
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 }, latency_ms: 1, raw: {}, deviations: [],
    });

    const orchestratorCfg: RosterAgentConfig = {
      ...orchestratorConfig(orchestratorAdapter),
      availableTools: ["request_quote"],
    };
    const workerCfg: RosterAgentConfig = {
      agentId: "WORKER-CODE",
      adapter: workerAdapter,
      modelString: "claude-sonnet-5",
      prices: PRICES,
      skillPackText: `${loadSkill("quote-and-deliver").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}`,
      availableTools: ["issue_quote"],
      privateKeyHex: "0xe39cf58360ba4b1edb7b69cd985693a0fb0976837017cd4e47099136dbbe3983",
      address: "0x0000000000000000000000000000000000000002",
      erc8004Id: "erc8004:0xWORKERCODE",
      rpcUrl: "http://127.0.0.1:1",
      maxOutputTokens: 3000,
    };

    const budgetCeiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 5, maxInferenceUsd: "2" },
      "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 5, maxInferenceUsd: "2" },
      "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    });
    const budget = new ExperimentBudget({ ceiling: budgetCeiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath });

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorCfg, workerCfg],
      job: JOB,
      maxTurnsPerAgent: 2,
      budget,
      deps: fakeDeps(async () => PASS),
      runsRoot, runId: "run-board", manifest: MANIFEST,
    });

    // WORKER-CODE's own first (and only) turn saw the real, posted request on its own board view.
    expect(result.turnLogsByAgent["WORKER-CODE"][0].marketBoardText).toContain("qr-1");
    expect(result.turnLogsByAgent["WORKER-CODE"][0].marketBoardText).toContain("ORCHESTRATOR");
    // ORCHESTRATOR's second turn saw WORKER-CODE's real, signed answer back.
    expect(result.turnLogsByAgent.ORCHESTRATOR[1].marketBoardText).toContain("qr-1");
    expect(result.turnLogsByAgent.ORCHESTRATOR[1].marketBoardText).toContain("erc8004:0xWORKERCODE");
    // ORCHESTRATOR's first turn (before anything was answered) saw no board at all.
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].marketBoardText).toBeUndefined();
  });
});
