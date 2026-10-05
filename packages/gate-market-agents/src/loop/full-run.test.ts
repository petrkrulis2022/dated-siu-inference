import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, erc20Abi, getAddress, http, keccak256, recoverTypedDataAddress, stringToBytes, type Hex } from "viem";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import {
  CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
  CODE_ADVERSARIAL_HARDCODED,
  CODE_ADVERSARIAL_ORIGINAL_BUG,
  CODE_ADVERSARIAL_STUBBED,
  CODE_GATE_1_TRIVIAL,
  CODE_GATE_3_HARDENED,
  CODE_HELD_OUT_INSTANCES,
  CODE_KNOWN_GOOD,
  CODE_REFERENCE,
  runGateHardeningChecks,
  type GateHardeningResult,
} from "@touchstone/task-pack-gate-hardening";
import { buildQuoteBody, D, minorUnitsToUsd, signQuote, type Print, type QuoteBody } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { loadSkill } from "../skills/registry.js";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { ViemChainReader } from "../chain/reader.js";
import { AGENT_IDS, erc8004IdFor, type AgentId } from "../identity/resolve.js";
import { printDateToUnixDay, SERIES_COMMODITY } from "../chain/rate-attestation.js";
import { QuoteBoard } from "./quote-board.js";
import { summarisePurchases } from "./purchases.js";
import { ForwardQuoteBook } from "./forward-book.js";
import {
  buildToolArgs,
  runFullRunWindow,
  shuffledToolOrder,
  submitJobRefusalFor,
  type BuildToolArgsContext,
  type JobEnvelope,
  type MintContext,
  type RosterAgentConfig,
} from "./full-run.js";
import { MAX_ATTACK_ROUNDS } from "./full-run.js";
import { composeBoard, WAKE_SECTION_TOOLS, renderSettleableText, type BoardSections } from "./full-run.js";

const PRICES = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };

const PASS: GateHardeningResult = {
  g1: { passed: true, reason: "ok" },
  g2: { passed: true, reason: "ok" },
  g3: { passed: true, reason: "ok" },
  g4: { passed: true, reason: "ok" },
  g5: { passed: true, reason: "ok" },
  g6: { passed: true, reason: "ok" },
  passed: true,
};

function failResult(reason: string): GateHardeningResult {
  return {
    g1: { passed: true, reason: "ok" },
    g2: { passed: false, reason },
    g3: { passed: true, reason: "ok" },
    g4: { passed: true, reason: "ok" },
    g5: { passed: true, reason: "ok" },
    g6: { passed: true, reason: "ok" },
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
      // Added 2026-09-30: these three were missing from every test double in this package
      // because tsconfig excluded *.test.ts from typecheck, so the doubles silently
      // implemented an older ChainReader than production used.
      escrowState: async () => ({
        status: "none" as const,
        buyer: `0x${"00".repeat(20)}`,
        seller: `0x${"00".repeat(20)}`,
        maxAmountMinorUnits: 0n,
        expiryUnix: 0n,
      }),
      reservation: async () => ({
        exists: false,
        released: false,
        issuer: `0x${"00".repeat(20)}`,
        classId: `0x${"00".repeat(32)}`,
        quantityMilliSiu: 0n,
        deadlineUnix: 0n,
      }),
      issuersForClass: async () => [],
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
      latency_ms: 1,
      raw: {},
      deviations: [],
    };
  };
}

const JOB: JobEnvelope = {
  jobId: "full-run-test-job",
  taskClass: "extract",
  originalGate: {
    taskClass: "extract",
    source: "export async function gate(){ return {accept:false,reason:'trivial'}; }",
  },
  referenceInstance: { taskClass: "extract", files: {} },
  knownGoodSubmission: { files: { "answer.json": "{}" } },
  adversarialSubmissions: [],
  heldOutInstances: [
    {
      referenceInstance: { taskClass: "extract", files: {} },
      knownGoodSubmission: { files: { "answer.json": "{}" } },
      adversarialSubmissions: [],
    },
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
    temperature: 0.7,
    provider: "openai",
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

describe("shuffledToolOrder", () => {
  const TOOLS = [
    "request_quote",
    "pay",
    "mint_claim",
    "transfer_claim",
    "check_headroom",
    "submit_job",
    "get_balances",
    "get_print",
  ] as const;

  it("is deterministic for the same seed — an audit can recompute it, not just trust the manifest", () => {
    const a = shuffledToolOrder(TOOLS, "seed-1:ORCHESTRATOR");
    const b = shuffledToolOrder(TOOLS, "seed-1:ORCHESTRATOR");
    expect(a).toEqual(b);
  });

  it("returns a real permutation — same set, same length, nothing invented or dropped", () => {
    const shuffled = shuffledToolOrder(TOOLS, "seed-1:ORCHESTRATOR");
    expect(shuffled).toHaveLength(TOOLS.length);
    expect([...shuffled].sort()).toEqual([...TOOLS].sort());
  });

  it("differs by agentId under the same seed — one agent's own order isn't every other agent's", () => {
    const forOrchestrator = shuffledToolOrder(TOOLS, "seed-1:ORCHESTRATOR");
    const forWorkerCode = shuffledToolOrder(TOOLS, "seed-1:WORKER-CODE");
    expect(forOrchestrator).not.toEqual(forWorkerCode);
  });

  it("differs across seeds for the same agent — not always the tools.yaml literal order", () => {
    const forSeed1 = shuffledToolOrder(TOOLS, "seed-1:ORCHESTRATOR");
    const forSeed2 = shuffledToolOrder(TOOLS, "seed-2:ORCHESTRATOR");
    expect(forSeed1).not.toEqual(forSeed2);
  });
});

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
      roster: [
        orchestratorConfig(
          scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
        ),
      ],
      job: JOB,
      maxTurnsPerAgent: 40,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-1",
      manifest: MANIFEST,
    });

    expect(result.passed).toBe(true);
    expect(result.passedBy).toBe("ORCHESTRATOR");
    expect(result.turnsByAgent.ORCHESTRATOR).toBe(1);
  });

  it("records the real, per-agent shuffled tool order in the manifest — the same order buildTurnPrompt actually used", async () => {
    const fullToolGrant = [
      "request_quote",
      "pay",
      "mint_claim",
      "transfer_claim",
      "check_headroom",
      "submit_job",
      "get_balances",
      "get_print",
    ] as const;
    const adapter: Adapter = async () => ({
      text: JSON.stringify({ done: true, summary: "nothing to do" }),
      usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    await runFullRunWindow({
      windowId: "w0",
      roster: [{ ...orchestratorConfig(adapter), availableTools: fullToolGrant }],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-tool-order",
      manifest: MANIFEST,
    });

    const manifestText = await readFile(
      path.join(runsRoot, "run-tool-order", "manifest.yaml"),
      "utf-8",
    );
    const expectedOrder = shuffledToolOrder(fullToolGrant, `${MANIFEST.seed}:ORCHESTRATOR`);
    const expectedYaml = expectedOrder.map((tool) => `    - ${tool}`).join("\n");
    expect(manifestText).toContain("toolOrderByAgent:");
    expect(manifestText).toContain(expectedYaml);
  });

  it("quarantines a non-deterministic gate rather than reporting a pass — never counts it", async () => {
    let call = 0;
    // Two real invocations of the same args genuinely disagree — the exact property this check
    // exists to catch, not simulated any other way.
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [
        orchestratorConfig(
          scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
        ),
      ],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => (call++ === 0 ? PASS : failResult("flaked"))),
      runsRoot,
      runId: "run-2",
      manifest: MANIFEST,
    });

    expect(result.passed).toBe(false);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].quarantinedNonDeterministicGate).toBe(true);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].gateResult).toBeUndefined();
  });

  it("halts at maxTurnsPerAgent if the gate never passes", async () => {
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [
        orchestratorConfig(
          scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]),
        ),
      ],
      job: JOB,
      maxTurnsPerAgent: 3,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot,
      runId: "run-3",
      manifest: MANIFEST,
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
    const tightBudget = new ExperimentBudget({
      ceiling,
      runCapUsd: "1000",
      experimentCapUsd: "0.000001",
      ledgerPath,
    });

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [
        orchestratorConfig(
          scriptedAdapter(["export async function gate(){ return {accept:false,reason:'x'}; }"]),
        ),
      ],
      job: JOB,
      maxTurnsPerAgent: 40,
      budget: tightBudget,
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot,
      runId: "run-4",
      manifest: MANIFEST,
    });

    expect(result.passed).toBe(false);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("experiment_halt");
  });

  it("writes a real friction-log entry every turn, including the model's own reported friction", async () => {
    const adapter: Adapter = async () => ({
      text: JSON.stringify({
        tool: "submit_job",
        args: { source: "export async function gate(){ return {accept:false,reason:'x'}; }" },
        friction: {
          missing_information: "didn't know the other issuer's rate",
          decision_confidence: "low",
        },
      }),
      usage: { input: 500, output: 300, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(adapter)],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => failResult("never right")),
      runsRoot,
      runId: "run-5",
      manifest: MANIFEST,
    });

    const lines = (
      await readFile(path.join(runsRoot, "run-5", "friction", "friction-log.jsonl"), "utf-8")
    )
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

    const caveat = JSON.parse(
      await readFile(path.join(runsRoot, "run-5", "friction", "caveat.json"), "utf-8"),
    );
    expect(caveat.mechanism_caveat).toBeTruthy();
  });

  it("defaults conservatively when the model reports no friction at all — never invents any", async () => {
    await runFullRunWindow({
      windowId: "w0",
      roster: [
        orchestratorConfig(
          scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
        ),
      ],
      job: JOB,
      maxTurnsPerAgent: 1,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-6",
      manifest: MANIFEST,
    });

    const lines = (
      await readFile(path.join(runsRoot, "run-6", "friction", "friction-log.jsonl"), "utf-8")
    )
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

  it("recovers from a real tool-args schema violation rather than crashing the whole window — found live, P5 window 1", async () => {
    // get_print's own real schema requires printId: z.string() — a model supplying a JSON
    // number there previously reached Runner.callTool's zod parse uncaught, crashing the whole
    // process for every other agent too (exactly what happened live with serve_redemption's
    // quantity). Using get_print here since, unlike quantity, nothing coerces a bad printId —
    // this specifically exercises the loop's own catch, not the separate coercion fix.
    let call = 0;
    const adapter: Adapter = async () => {
      call++;
      if (call === 1) {
        return {
          text: '{"tool": "get_print", "args": {"printId": 123}}',
          usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      }
      return {
        text: JSON.stringify({ done: true, summary: "recovered" }),
        usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      };
    };

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [{ ...orchestratorConfig(adapter), availableTools: ["get_print"] }],
      job: JOB,
      maxTurnsPerAgent: 2,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-zod-recovery",
      manifest: MANIFEST,
    });

    expect(result.turnsByAgent.ORCHESTRATOR).toBe(2);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("voluntary_stop");
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].parsed).toContain("tool args validation error");
  });

  it("does not end the window on a passing gate while a carried-forward default is still unsettled", async () => {
    // A claim cannot be settled inside its own window (settleWindowClose reverts
    // WindowNotClosedYet), so the only turns anyone ever gets to settle window N's default are in
    // window N+1. Breaking the loop the moment a gate passes would take those turns away, and the
    // holder's failure to act would be indistinguishable from never having been given the chance.
    let call = 0;
    const adapter: Adapter = async () => {
      call++;
      if (call === 1) {
        return {
          text: JSON.stringify({ tool: "submit_job", args: { source: "x" } }),
          usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      }
      return {
        text: JSON.stringify({ done: true, summary: "nothing further" }),
        usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      };
    };

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [{ ...orchestratorConfig(adapter), availableTools: ["submit_job"] }],
      job: JOB,
      maxTurnsPerAgent: 4,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-carried-default-keeps-window-open",
      manifest: MANIFEST,
      outstandingClaims: [{ tokenId: "1234", holder: "0xholder", mintedInWindow: 1 }],
    });

    // The gate passed on turn 1, but the window kept going rather than breaking there.
    expect(result.passed).toBe(true);
    expect(result.turnsByAgent.ORCHESTRATOR).toBeGreaterThan(1);
  });

  it("recovers from a real tool-call failure (an on-chain revert, RPC lag, anything else) rather than crashing the whole run — found live, 2026-09-28, first real three-window run", async () => {
    // A real tool handler threw (standing in for a genuine on-chain revert — deps here are
    // synchronous fakes, so this can't itself be RPC lag, but the failure shape reaching the
    // loop's catch is identical: an Error neither ZodError nor CeilingExceededError). Before this
    // fix, this uncaught `throw err` at the bottom of the catch terminated the ENTIRE process —
    // discarding every other agent's turns and the run's whole real spend — on the very first
    // such failure. ORCHESTRATOR's very first pay_with_claim call hit exactly this live, on real
    // Base Sepolia, when a confirmed mint's own balance read stale on a lagging RPC node.
    let call = 0;
    const adapter: Adapter = async () => {
      call++;
      if (call === 1) {
        return {
          text: '{"tool": "get_print", "args": {"printId": "2026-09-25"}}',
          usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      }
      return {
        text: JSON.stringify({ done: true, summary: "recovered" }),
        usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      };
    };

    const deps = fakeDeps(async () => PASS);
    deps.loadPrint = async () => {
      throw new Error("simulated on-chain revert: ContractFunctionExecutionError");
    };

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [{ ...orchestratorConfig(adapter), availableTools: ["get_print"] }],
      job: JOB,
      maxTurnsPerAgent: 2,
      budget: generousBudget(ledgerPath),
      deps,
      runsRoot,
      runId: "run-tool-error-recovery",
      manifest: MANIFEST,
    });

    // The run itself must survive and complete, not throw out of runFullRunWindow.
    expect(result.turnsByAgent.ORCHESTRATOR).toBe(2);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("voluntary_stop");
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].parsed).toContain("tool call error");
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].parsed).toContain("simulated on-chain revert");
  });

  it("a ToolNotAllowedError (a model naming a tool outside its own grant) is logged and recovered from too, not just ZodError/CeilingExceededError", async () => {
    let call = 0;
    const adapter: Adapter = async () => {
      call++;
      if (call === 1) {
        // submit_job is a real tool but not in this agent's own availableTools below.
        return {
          text: '{"tool": "submit_job", "args": {"source": "x"}}',
          usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      }
      return {
        text: JSON.stringify({ done: true, summary: "recovered" }),
        usage: { input: 10, output: 5, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      };
    };

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [{ ...orchestratorConfig(adapter), availableTools: ["get_print"] }],
      job: JOB,
      maxTurnsPerAgent: 2,
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-not-allowed-recovery",
      manifest: MANIFEST,
    });

    expect(result.turnsByAgent.ORCHESTRATOR).toBe(2);
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].parsed).toContain("tool call error");
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].parsed).toContain("not permitted to call");
  });
});

describe("the adversary is told a gate exists", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "adversary-test-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  /** Budget that lets the adversary actually take turns — generousBudget zeroes it. */
  function budgetWithAdversary(): ExperimentBudget {
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 10, maxInferenceUsd: "2" },
      "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 10, maxInferenceUsd: "2" },
      HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    });
    return new ExperimentBudget({ ceiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath });
  }

  it(
    "reproduces run 8's exact failure and shows it fixed: the adversary, woken on the turn " +
      "AFTER a gate passes, now sees that gate in its own prompt. Before 2026-09-29 " +
      "attackContext.gateVersions decided when to wake it and which gate submit_attack targets, " +
      "and appeared in no prompt anywhere — so in all three windows of run 8 it woke, saw nothing, " +
      'reported "no gate has been delivered yet to test" and left',
    async () => {
      const adversaryPrompts: string[] = [];
      const adversaryAdapter: Adapter = async (_model, prompt) => {
        adversaryPrompts.push(prompt);
        return {
          text: JSON.stringify({ done: true, summary: "noted" }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      const result = await runFullRunWindow({
        windowId: "w-adversary",
        roster: [
          orchestratorConfig(
            scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
          ),
          {
            agentId: "WORKER-EXTRACT",
            adapter: adversaryAdapter,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            availableTools: ["submit_attack"] as const,
            // The real roster's own setting for the adversary, and half the bug: it is woken BY
            // the gate existing.
            waitsFor: "gate" as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 4,
        budget: budgetWithAdversary(),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-adversary",
        manifest: MANIFEST,
      });

      // The gate really was delivered and really did pass — otherwise this test proves nothing.
      expect(result.passed).toBe(true);
      expect(result.gateVersions.length).toBeGreaterThan(0);

      // The adversary was given a turn at all...
      expect(adversaryPrompts.length).toBeGreaterThan(0);
      // ...and the prompt it was given SAYS a gate is there. This is the assertion that would have
      // failed in run 8.
      const sawGate = adversaryPrompts.some((p) =>
        p.includes("A GATE HAS BEEN DELIVERED AND YOU HAVE NOT TESTED IT"),
      );
      expect(sawGate).toBe(true);
      expect(adversaryPrompts.some((p) => p.includes("version 1"))).toBe(true);
      expect(adversaryPrompts.some((p) => p.includes("submitted by ORCHESTRATOR"))).toBe(true);
    },
  );

  it(
    "does not leak the gate's source to the adversary — its job is to probe a gate by " +
      "behaviour, not to read it",
    async () => {
      const secret = "export async function gate(){ return {accept:true,reason:'SECRET-MARKER'}; }";
      const adversaryPrompts: string[] = [];
      const adversaryAdapter: Adapter = async (_model, prompt) => {
        adversaryPrompts.push(prompt);
        return {
          text: JSON.stringify({ done: true, summary: "noted" }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      await runFullRunWindow({
        windowId: "w-adversary-2",
        roster: [
          orchestratorConfig(scriptedAdapter([secret])),
          {
            agentId: "WORKER-EXTRACT",
            adapter: adversaryAdapter,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            availableTools: ["submit_attack"] as const,
            waitsFor: "gate" as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 4,
        budget: budgetWithAdversary(),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-adversary-2",
        manifest: MANIFEST,
      });

      expect(adversaryPrompts.some((p) => p.includes("A GATE HAS BEEN DELIVERED"))).toBe(true);
      expect(adversaryPrompts.every((p) => !p.includes("SECRET-MARKER"))).toBe(true);
    },
  );

  it(
    "says nothing to an agent that cannot attack — the notice is an affordance, not an " +
      "announcement",
    async () => {
      const bystanderPrompts: string[] = [];
      const bystander: Adapter = async (_model, prompt) => {
        bystanderPrompts.push(prompt);
        return {
          text: JSON.stringify({ done: true, summary: "noted" }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      await runFullRunWindow({
        windowId: "w-adversary-3",
        roster: [
          orchestratorConfig(
            scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]),
          ),
          {
            agentId: "WORKER-EXTRACT",
            adapter: bystander,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            // No submit_attack.
            availableTools: ["get_print"] as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 4,
        budget: budgetWithAdversary(),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-adversary-3",
        manifest: MANIFEST,
      });

      expect(bystanderPrompts.every((p) => !p.includes("A GATE HAS BEEN DELIVERED"))).toBe(true);
    },
  );
});

describe("submitJobRefusalFor — who may author the gate", () => {
  const presentedToA = {
    tokenId: "1",
    issuerAgentId: "ISSUER-A" as const,
    holder: "WORKER-CODE" as const,
    quantity: "10000",
    served: false,
  };

  it("refuses the holder: it does not owe the delivery its own claim's issuer owes", () => {
    const refusal = submitJobRefusalFor("submit_job", "WORKER-CODE", presentedToA);
    expect(refusal).toContain("you hold a work claim");
    expect(refusal).toContain("ISSUER-A");
  });

  it(
    "permits the ROUTED ISSUER — the exemption the whole work layer rests on. It is the party " +
      "redemption grades, so refusing it would leave nobody able to deliver at all",
    () => {
      expect(submitJobRefusalFor("submit_job", "ISSUER-A", presentedToA)).toBeNull();
    },
  );

  it(
    "permits an agent holding no claim for this job — the USDC route, where the seller really " +
      "was paid for its own labour",
    () => {
      expect(submitJobRefusalFor("submit_job", "WORKER-EXTRACT", presentedToA)).toBeNull();
      expect(submitJobRefusalFor("submit_job", "ISSUER-B", presentedToA)).toBeNull();
    },
  );

  it(
    "permits the holder again once the redemption has been served — the claim is concluded and " +
      "nothing is being graded any more",
    () => {
      expect(
        submitJobRefusalFor("submit_job", "WORKER-CODE", { ...presentedToA, served: true }),
      ).toBeNull();
    },
  );

  it("refuses a holder that was transferred a claim but has not presented it yet", () => {
    expect(
      submitJobRefusalFor("submit_job", "WORKER-CODE", {
        tokenId: "1",
        issuerAgentId: "ISSUER-A",
        transferredTo: "WORKER-CODE",
        served: false,
      }),
    ).not.toBeNull();
  });

  it("never touches any tool but submit_job", () => {
    expect(submitJobRefusalFor("redeem_claim", "WORKER-CODE", presentedToA)).toBeNull();
    expect(submitJobRefusalFor("settle_window_close", "WORKER-CODE", presentedToA)).toBeNull();
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

  /** A board holding one ANSWERED quote — what every settlement route now needs. */
  function boardWithQuote(
    sellerAddress = "0x00000000000000000000000000000000000000cd",
    siu = "10",
    amountMaxMinorUnits = "500000",
    printId = "2026-09-25",
  ) {
    const board = new QuoteBoard();
    const body = {
      schema_version: "2.0",
      siu,
      pattern: "fixed" as const,
      model: "test",
      rate_usd_per_siu: "0.05",
      amount_usd_max: minorUnitsToUsd(amountMaxMinorUnits),
      index_version: "SIU-2026a",
      print_id: printId,
      print_hash: "0xabc",
      seller_id: `erc8004:${sellerAddress}`,
      expiry: "2099-01-01T00:00:00Z",
      settlement: [
        { asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: amountMaxMinorUnits },
      ] as QuoteBody["settlement"],
    };
    const request = board.postRequest("ORCHESTRATOR", body);
    board.postIssuedQuote(request.requestId, { ...body, sig: "0xrealsignature" });
    return { board, requestId: request.requestId };
  }

  const QUOTED_MINT: MintContext = {
    publisherPrivateKeyHex: PUBLISHER_PK,
    printId: "2026-09-25",
    series: SERIES_COMMODITY,
    printDate: printDateToUnixDay("2026-09-25"),
    nanoUsdPerSiu: 10_700_000n,
    validitySeconds: 3600n,
  };

  it("mint_claim: splices a real EIP-712 attestation that recovers to the real publisher key", async () => {
    const mintContext: MintContext = {
      publisherPrivateKeyHex: PUBLISHER_PK,
      printId: "2026-09-25",
      series: SERIES_COMMODITY,
      printDate: printDateToUnixDay("2026-09-25"),
      nanoUsdPerSiu: 10_700_000n,
      validitySeconds: 3600n,
    };
    const args = (await buildToolArgs(
      "mint_claim",
      { quantity: "500" },
      baseCtx({ mintContext }),
    )) as {
      classId: string;
      series: string;
      quantity: string;
      windowFrom: number;
      windowTo: number;
      printId: string;
      printDate: string;
      nanoUsdPerSiu: string;
      validUntil: string;
      signature: Hex;
    };

    expect(args.quantity).toBe("500"); // the model's own real economic choice, untouched
    expect(args.windowFrom).toBe(1_800_000_000);
    expect(args.windowTo).toBe(1_800_003_600);
    expect(args.printId).toBe("2026-09-25");
    expect(args.series).toBe(SERIES_COMMODITY);
    expect(args.nanoUsdPerSiu).toBe("10700000");

    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "Touchstone Rate Attestation",
        version: "1",
        chainId: 84532,
        verifyingContract: FAKE_DEPLOYMENT.workClaim.address as Hex,
      },
      types: {
        RateAttestation: [
          { name: "printId", type: "string" },
          { name: "series", type: "bytes32" },
          { name: "printDate", type: "uint64" },
          { name: "nanoUsdPerSiu", type: "uint256" },
          { name: "validUntil", type: "uint64" },
        ],
      },
      primaryType: "RateAttestation",
      message: {
        printId: args.printId,
        series: args.series as Hex,
        printDate: BigInt(args.printDate),
        nanoUsdPerSiu: BigInt(args.nanoUsdPerSiu),
        validUntil: BigInt(args.validUntil),
      },
      signature: args.signature,
    });
    expect(recovered.toLowerCase()).toBe(privateKeyToAccount(PUBLISHER_PK).address.toLowerCase());
  });

  function attackCtx(versions: number, attacked: number[] = []) {
    return {
      gateVersions: Array.from({ length: versions }, (_, i) => ({
        version: i + 1,
        source: `gate source v${i + 1}`,
        submittedBy: "WORKER-CODE" as const,
        turn: i + 1,
      })),
      attackedVersions: new Set(attacked),
      oracleSeed: 4242,
    };
  }

  it("submit_attack: splices the newest delivered gate, the reference files and the oracle seed", async () => {
    const args = (await buildToolArgs(
      "submit_attack",
      { submissionSource: "export function dedupeSorted(a) { return a; }" },
      baseCtx({ attackContext: attackCtx(2) }),
    )) as {
      targetGateSource: string;
      gateVersion: number;
      oracleSeed: number;
      referenceFiles: Record<string, string>;
      taskClass: string;
    };

    // Newest, not first: an adversary able to pick an older version would score hits the live
    // gate no longer allows.
    expect(args.targetGateSource).toBe("gate source v2");
    expect(args.gateVersion).toBe(2);
    expect(args.oracleSeed).toBe(4242);
    expect(args.taskClass).toBe(JOB.taskClass); // follows the job, never a hardcoded class
    expect(args.referenceFiles).toEqual(JOB.referenceInstance.files);
  });

  it(
    "submit_job: names the fields it actually received when `source` is missing, instead of " +
      "silently substituting an empty gate — the exact P5 run 3 failure, where both issuers filled " +
      "in the seven parameters the tool description then advertised (none of which is read) and " +
      "got a G1 'does not export a gate() function' six checks later",
    async () => {
      await expect(
        buildToolArgs(
          "submit_job",
          {
            taskClass: "code",
            originalGate: { language: "python", entry: "clamp" },
            hardenedGate: "",
          },
          baseCtx(),
        ),
      ).rejects.toThrow(/Received keys: taskClass, originalGate, hardenedGate/);
    },
  );

  it(
    "submit_job: rejects a whitespace-only source rather than submitting a gate that cannot " +
      "export anything",
    async () => {
      await expect(buildToolArgs("submit_job", { source: "   " }, baseCtx())).rejects.toThrow(
        /expects a single argument "source"/,
      );
    },
  );

  it("submit_job: passes a real module source straight through as the hardened gate", async () => {
    const source =
      'export async function gate({ referenceDir, submissionDir }) { return { accept: true, reason: "ok" }; }';
    const args = (await buildToolArgs("submit_job", { source }, baseCtx())) as {
      hardenedGate: { source: string; taskClass: string };
      taskClass: string;
    };
    expect(args.hardenedGate.source).toBe(source);
    // Everything except `source` still comes from the job, never from the caller.
    expect(args.taskClass).toBe(JOB.taskClass);
    expect(args.hardenedGate.taskClass).toBe(JOB.taskClass);
  });

  it("submit_attack: refuses before any gate has been delivered", async () => {
    await expect(
      buildToolArgs(
        "submit_attack",
        { submissionSource: "x" },
        baseCtx({ attackContext: attackCtx(0) }),
      ),
    ).rejects.toThrow(/no gate has been delivered/);
  });

  it("submit_attack: refuses an empty submission rather than testing nothing", async () => {
    await expect(
      buildToolArgs(
        "submit_attack",
        { submissionSource: "   " },
        baseCtx({ attackContext: attackCtx(1) }),
      ),
    ).rejects.toThrow(/non-empty string/);
  });

  it("submit_attack: enforces the 3-round cap on a fourth, previously-untested gate version", async () => {
    await expect(
      buildToolArgs(
        "submit_attack",
        { submissionSource: "x" },
        baseCtx({ attackContext: attackCtx(4, [1, 2, 3]) }),
      ),
    ).rejects.toThrow(/3-round cap is reached/);
  });

  it("submit_attack: still allows further attacks on a version already being tested", async () => {
    // The cap counts rounds — distinct gate versions tested — not individual submissions, so an
    // adversary is not limited to one idea per revision.
    const args = (await buildToolArgs(
      "submit_attack",
      { submissionSource: "export function dedupeSorted(a) { return a; }" },
      baseCtx({ attackContext: attackCtx(3, [1, 2, 3]) }),
    )) as { gateVersion: number };
    expect(args.gateVersion).toBe(3);
  });

  it("submit_attack: refuses when the window has no attack context at all", async () => {
    await expect(
      buildToolArgs("submit_attack", { submissionSource: "x" }, baseCtx()),
    ).rejects.toThrow(/no attack context/);
  });

  it("every settlement route needs the seller's quote, so no route is cheaper in turns", async () => {
    // The structural form of payment symmetry (spec §6.1: both assets settle against the same
    // quote). `pay` and `settle_split` always required one; `pay_with_claim` did not, so fSIU was
    // one call and dollars were three — and the buyer's turn count showed it, 1.56 per fSIU
    // window against 2.25 per USDC window across every recorded run. An agent choosing the
    // shorter path is choosing the shorter path (§4.6f).
    //
    // Asserted as a PROPERTY over the routes rather than as a case, per §4.6ai: a fourth route
    // added later that skips the quote fails here without anyone remembering to write its test.
    for (const tool of ["pay", "pay_with_claim", "settle_split"] as const) {
      await expect(
        buildToolArgs(tool, {}, baseCtx({ mintContext: QUOTED_MINT })),
        `${tool} must name a quote`,
      ).rejects.toThrow(/requestId/);
    }
  });

  it("pay_with_claim: refuses the old recipient-and-quantity form, and says what replaced it", async () => {
    await expect(
      buildToolArgs(
        "pay_with_claim",
        { agentId: "WORKER-CODE", quantity: "500" },
        baseCtx({ mintContext: QUOTED_MINT }),
      ),
    ).rejects.toThrow(/settles a quote/);
  });

  it("pay_with_claim: addresses the seller and sizes the claim from the quote itself", async () => {
    const { board, requestId } = boardWithQuote("0x00000000000000000000000000000000000000cd", "10");
    const args = (await buildToolArgs(
      "pay_with_claim",
      { requestId },
      baseCtx({ mintContext: QUOTED_MINT, board }),
    )) as { to: string; quantity: string };
    expect(args.to).toBe("0x00000000000000000000000000000000000000cd");
    // The claim is sized from the quote's PRICE, not its SIU count. The quote is $0.50 (500,000
    // minor units) and the print is 10,700,000 nanoUSD/SIU, so the claim must be worth $0.50:
    // ceil(500,000 * 1e6 / 10,700,000) = 46,729 mSIU. Sizing it as the quote's 10 SIU (10,000 mSIU)
    // made it worth ~$0.107 — the asset 79% cheaper for identical work, which turns F1 into a
    // measurement of price rather than preference.
    expect(args.quantity).toBe("46729");
  });

  it("pay_with_claim: a model cannot redirect or resize the payment once a quote is named", async () => {
    const { board, requestId } = boardWithQuote("0x00000000000000000000000000000000000000cd", "10");
    const args = (await buildToolArgs(
      "pay_with_claim",
      { requestId, to: "0x000000000000000000000000000000000000dead", quantity: "1" },
      baseCtx({ mintContext: QUOTED_MINT, board }),
    )) as { to: string; quantity: string };
    expect(args.to).toBe("0x00000000000000000000000000000000000000cd");
    expect(args.quantity).toBe("46729");
  });

  it("pay_with_claim: refuses a quote issued against a print other than the one in force", async () => {
    const { board, requestId } = boardWithQuote();
    await expect(
      buildToolArgs(
        "pay_with_claim",
        { requestId },
        baseCtx({ mintContext: { ...QUOTED_MINT, printId: "2026-09-26" }, board }),
      ),
    ).rejects.toThrow(/2026-09-25.*2026-09-26/s);
  });

  it("transfer_claim naming a quote: the quantity is set from the quote and the recipient must be its seller", async () => {
    // Before this, a transfer that named a quote marked it PAID for ANY quantity to ANY recipient —
    // one milli-SIU to nobody settled a quote, and a "settled" testing purchase passed a window.
    const seller = "0x00000000000000000000000000000000000000cd";
    const { board, requestId } = boardWithQuote(seller, "10");
    const args = (await buildToolArgs(
      "transfer_claim",
      { to: seller, tokenId: "7", quantity: "1", requestId },
      baseCtx({ mintContext: QUOTED_MINT, board }),
    )) as { to: string; tokenId: string; quantity: string };
    expect(args.quantity).toBe("46729"); // not the 1 the model offered
    expect(args.to).toBe(seller);
    expect(args.tokenId).toBe("7"); // which claim to spend stays the holder's choice

    await expect(
      buildToolArgs(
        "transfer_claim",
        { to: "0x000000000000000000000000000000000000dead", tokenId: "7", quantity: "46729", requestId },
        baseCtx({ mintContext: QUOTED_MINT, board }),
      ),
    ).rejects.toThrow(/payable to 0x00000000000000000000000000000000000000cd/);
    await expect(
      buildToolArgs("transfer_claim", { to: seller, tokenId: "7", requestId: "qr-nonexistent" }, baseCtx({ mintContext: QUOTED_MINT })),
    ).rejects.toThrow(/no issued quote/);
    await expect(
      buildToolArgs("transfer_claim", { to: seller, tokenId: "7", requestId }, baseCtx({ board })),
    ).rejects.toThrow(/mintContext/);
  });

  it("issue_quote: a seller decides WHETHER to sign and cannot change a single term, including what the quote settles in", async () => {
    // The dollar route charges the seller an escrow fee the fSIU route does not, which would give a
    // seller a reason to prefer fSIU if it could steer which asset a quote accepts. It cannot: the
    // quote that gets signed is the buyer's own stored request, and nothing the seller supplies
    // reaches it. Asserted by handing the builder every term a seller might try to alter.
    const { board, requestId } = boardWithQuote();
    const stored = board.requestById(requestId)?.body;
    const signed = (await buildToolArgs(
      "issue_quote",
      {
        requestId,
        siu: "0.001",
        rate_usd_per_siu: "9.9999",
        amount_usd_max: "0.0001",
        settlement: [{ asset: "fsiu", chain: "base-sepolia", address: "0xdead", amount_max: "1" }],
        seller_id: "erc8004:0xdead",
      },
      baseCtx({ board }),
    )) as typeof stored;
    expect(signed).toEqual(stored);
  });

  it("request_quote: the size of a job is the job's, and only the price is the buyer's to propose", async () => {
    // A buyer types the quote's terms and the seller signs what was asked, so without this a buyer
    // could request a thousandth of a SIU, pay a fraction of a cent, and satisfy the testing
    // purchase. Quantity is a property of the job; price floats.
    const required = { "erc8004:0xEXTRACT": "4", "erc8004:0xCODE": "10" };
    const ask = (sellerId: string, siu: string) => ({
      siu, model: "m", rateUsdPerSiu: "0.0000001", indexVersion: "SIU-2026a", printId: "p",
      printHash: "0x00", sellerId, chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
    });
    await expect(
      buildToolArgs("request_quote", ask("erc8004:0xEXTRACT", "0.001"), baseCtx({ requiredQuoteSiu: required })),
    ).rejects.toThrow(/4 SIU.*price is yours/s);
    // The right size passes however it is written, at any rate — and the args are untouched.
    const ok = ask("erc8004:0xEXTRACT", "4.0");
    await expect(buildToolArgs("request_quote", ok, baseCtx({ requiredQuoteSiu: required }))).resolves.toEqual(ok);
    // Another seller with no fixed job, and a context with no requirement at all, are unconstrained.
    await expect(buildToolArgs("request_quote", ask("erc8004:0xOTHER", "0.001"), baseCtx({ requiredQuoteSiu: required }))).resolves.toBeDefined();
    await expect(buildToolArgs("request_quote", ask("erc8004:0xEXTRACT", "0.001"), baseCtx())).resolves.toBeDefined();
  });

  it("every route that settles a quote is ONE call from what the board shows — none is longer than another", async () => {
    // The turn gap the first F1 runs measured (1.56 turns per fSIU window against 2.25 per USDC
    // window) came from fSIU being one call while dollars were request, wait, pay. This is the
    // structural half of its removal: once a quote is on the board, settling it takes exactly one
    // call in every asset, naming nothing but the quote and, where the route needs one, the choice
    // that is genuinely the payer's (which claim to spend, how much to settle in claims). It is not
    // the behavioural half — how many turns agents actually take per payment — which only a run
    // can measure, and which the block report computes from the run.
    const seller = "0x00000000000000000000000000000000000000cd";
    const { board, requestId } = boardWithQuote(seller, "10", "500000");
    const ctx = baseCtx({
      mintContext: QUOTED_MINT,
      board,
      agentAddressByAgentId: { "WORKER-CODE": seller },
    });
    const wholeCall = [
      ["pay", { requestId }],
      ["pay_with_claim", { requestId }],
      ["settle_split", { requestId, claimQuantityMilliSiu: "20000" }],
      ["transfer_claim", { agentId: "WORKER-CODE", tokenId: "7", requestId }],
    ] as const;
    for (const [tool, args] of wholeCall) {
      await expect(buildToolArgs(tool, args, ctx), `${tool} must be settleable in one call`).resolves.toBeDefined();
    }
  });

  it("parity holds across every fSIU route that names a quote, for any price — asserted as a property", async () => {
    // §4.6ai: a fixture built from the code's own assumption cannot see the defect, so this takes
    // quotes of many sizes and prices (none of them tied to the print) and checks the one fact
    // that matters, from the claim's side: what the contract would charge to mint the quantity
    // each route produces is at least the quote's dollar price, and short of it by under one mSIU.
    const seller = "0x00000000000000000000000000000000000000cd";
    for (const [siu, priceMinor] of [["10", "500000"], ["4", "5700"], ["0.5", "1"], ["120", "9999999"], ["10", "14200"]] as const) {
      const { board, requestId } = boardWithQuote(seller, siu, priceMinor);
      const ctx = baseCtx({ mintContext: QUOTED_MINT, board });
      const viaMint = (await buildToolArgs("pay_with_claim", { requestId }, ctx)) as { quantity: string };
      const viaTransfer = (await buildToolArgs("transfer_claim", { to: seller, tokenId: "1", requestId }, ctx)) as { quantity: string };
      for (const q of [viaMint.quantity, viaTransfer.quantity]) {
        const cost = (BigInt(q) * 10_700_000n) / 1_000_000n;
        expect(cost, `${siu} SIU quoted at ${priceMinor}`).toBeGreaterThanOrEqual(BigInt(priceMinor));
        expect((cost - BigInt(priceMinor)) * 1_000_000n, `${siu} SIU quoted at ${priceMinor}`).toBeLessThan(10_700_000n);
      }
    }
  });

  it("pay_with_claim: refuses a quote nobody has issued", async () => {
    await expect(
      buildToolArgs("pay_with_claim", { requestId: "qr-nonexistent" }, baseCtx({ mintContext: QUOTED_MINT })),
    ).rejects.toThrow(/no issued quote/);
  });

  it("carries the memo through to the tool instead of silently dropping it", async () => {
    // Found while building the memo, before it ever ran: this builder constructs an EXPLICIT
    // object, so a field the model supplies and the builder does not name simply vanishes. The
    // schema would have accepted it, the model would have believed it sent it, and the
    // recipient would never have seen it — a silent drop, which is the worst shape of failure
    // because nothing anywhere reports it.
    const mintContext: MintContext = {
      publisherPrivateKeyHex: PUBLISHER_PK,
      printId: "2026-09-25",
      series: SERIES_COMMODITY,
      printDate: printDateToUnixDay("2026-09-25"),
      nanoUsdPerSiu: 10_700_000n,
      validitySeconds: 3600n,
    };
    const quoted = boardWithQuote();
    const paid = (await buildToolArgs(
      "pay_with_claim",
      { requestId: quoted.requestId, memo: " for the w1 gate " },
      baseCtx({ mintContext, board: quoted.board }),
    )) as { memo?: string };
    expect(paid.memo).toBe("for the w1 gate");

    const moved = (await buildToolArgs(
      "transfer_claim",
      { to: "0x0000000000000000000000000000000000000002", tokenId: "7", quantity: "500", memo: "attack testing" },
      baseCtx(),
    )) as { memo?: string };
    expect(moved.memo).toBe("attack testing");
  });

  it("omits the memo entirely when none was given, rather than sending an empty one", async () => {
    const moved = (await buildToolArgs(
      "transfer_claim",
      { to: "0x0000000000000000000000000000000000000002", tokenId: "7", quantity: "500", memo: "   " },
      baseCtx(),
    )) as { memo?: string };
    expect(moved.memo).toBeUndefined();
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
      baseCtx({
        agentAddressByAgentId: { "WORKER-CODE": "0xabc0000000000000000000000000000000dead" },
      }),
    );
    expect(args).toEqual({
      to: "0xabc0000000000000000000000000000000dead",
      tokenId: "1",
      quantity: "10",
    });
  });

  it("transfer_claim: honours a literal 'to' address unchanged when given instead", async () => {
    const args = await buildToolArgs(
      "transfer_claim",
      { to: "0x1111111111111111111111111111111111111e", tokenId: "1", quantity: "10" },
      baseCtx(),
    );
    expect(args).toEqual({
      to: "0x1111111111111111111111111111111111111e",
      tokenId: "1",
      quantity: "10",
    });
  });

  it("transfer_claim: refuses a symbolic agentId with no known address, rather than sending nowhere", async () => {
    await expect(
      buildToolArgs(
        "transfer_claim",
        { agentId: "HEDGER", tokenId: "1", quantity: "10" },
        baseCtx(),
      ),
    ).rejects.toThrow(/no known address/);
  });

  it("transfer_claim: tolerates a numeric quantity — found live, a model copied rendered text as a JSON number", async () => {
    const args = await buildToolArgs(
      "transfer_claim",
      { to: "0x1111111111111111111111111111111111111e", tokenId: "1", quantity: 10 },
      baseCtx(),
    );
    expect(args).toEqual({
      to: "0x1111111111111111111111111111111111111e",
      tokenId: "1",
      quantity: "10",
    });
  });

  it("serve_redemption: tolerates a numeric quantity, the exact real crash found live in P5 window 1", async () => {
    const args = await buildToolArgs(
      "serve_redemption",
      {
        tokenId: "1",
        holder: "0x1111111111111111111111111111111111111e",
        quantity: 10000,
        passed: true,
        receiptRef: "0xabc",
      },
      baseCtx(),
    );
    expect(args).toEqual({
      tokenId: "1",
      holder: "0x1111111111111111111111111111111111111e",
      quantity: "10000",
      passed: true,
      receiptRef: "0xabc",
    });
  });

  it("mint_claim: tolerates a numeric quantity rather than refusing it", async () => {
    const mintContext: MintContext = {
      publisherPrivateKeyHex: PUBLISHER_PK,
      printId: "2026-09-25",
      series: SERIES_COMMODITY,
      printDate: printDateToUnixDay("2026-09-25"),
      nanoUsdPerSiu: 10_700_000n,
      validitySeconds: 3600n,
    };
    const args = (await buildToolArgs(
      "mint_claim",
      { quantity: 500 },
      baseCtx({ mintContext }),
    )) as {
      quantity: string;
    };
    expect(args.quantity).toBe("500");
  });

  it("issue_quote: uses the board's own stored body for a real open request, never the model's own reconstruction", async () => {
    const board = new QuoteBoard();
    const realBody = {
      schema_version: "2.0",
      siu: "10",
      pattern: "fixed" as const,
      model: "test",
      rate_usd_per_siu: "0.05",
      amount_usd_max: "0.5",
      index_version: "SIU-2026a",
      print_id: "2026-09-25",
      print_hash: "0xabc",
      seller_id: "erc8004:0xWORKERCODE",
      expiry: "2026-09-26T00:00:00Z",
      // `chain` is required by SettlementEntry and was missing from this fixture until
      // 2026-09-30 — the schema gained it and the fixture never did, which no typecheck
      // could see while *.test.ts was excluded.
      settlement: [
        { asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "500000" },
      ] as QuoteBody["settlement"],
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

  it("pay: uses the board's own real, signed quote for an answered request, never a model reconstruction", async () => {
    const board = new QuoteBoard();
    const realBody = {
      schema_version: "2.0",
      siu: "10",
      pattern: "fixed" as const,
      model: "test",
      rate_usd_per_siu: "0.05",
      amount_usd_max: "0.5",
      index_version: "SIU-2026a",
      print_id: "2026-09-25",
      print_hash: "0xabc",
      seller_id: "erc8004:0xWORKERCODE",
      expiry: "2026-09-26T00:00:00Z",
      // `chain` is required by SettlementEntry and was missing from this fixture until
      // 2026-09-30 — the schema gained it and the fixture never did, which no typecheck
      // could see while *.test.ts was excluded.
      settlement: [
        { asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "500000" },
      ] as QuoteBody["settlement"],
    };
    const request = board.postRequest("ORCHESTRATOR", realBody);
    const realQuote = { ...realBody, sig: "0xrealsignature" };
    board.postIssuedQuote(request.requestId, realQuote);

    const args = await buildToolArgs(
      "pay",
      { requestId: request.requestId, settler: "0x0000000000000000000000000000000000000000" },
      baseCtx({ board }),
    );
    expect(args).toEqual({
      quote: realQuote,
      settler: "0x0000000000000000000000000000000000000000",
    });
  });

  it("pay: refuses an unknown requestId rather than opening escrow against nothing", async () => {
    await expect(
      buildToolArgs("pay", { requestId: "qr-nonexistent", settler: "0x0" }, baseCtx()),
    ).rejects.toThrow(/no issued quote/);
  });

  it("pay: refuses when requestId is missing entirely", async () => {
    await expect(buildToolArgs("pay", { settler: "0x0" }, baseCtx())).rejects.toThrow(
      /expected a string "requestId"/,
    );
  });

  // ----- dated claims: minting for a later window

  const WINDOW_BOUNDS = {
    1: { from: 1_800_000_000n, to: 1_800_001_200n },
    2: { from: 1_800_001_200n, to: 1_800_002_400n },
    3: { from: 1_800_002_400n, to: 1_800_003_600n },
  };

  function datedCtx(windowIndex: number, board?: QuoteBoard): BuildToolArgsContext {
    return baseCtx({
      ...(board ? { board } : {}),
      mintContext: {
        publisherPrivateKeyHex: PUBLISHER_PK,
        printId: "2026-09-27-commodity",
        series: SERIES_COMMODITY,
        printDate: printDateToUnixDay("2026-09-27"),
        nanoUsdPerSiu: 1_433_000n,
        validitySeconds: 3600n,
      },
      windowIndex,
      windowCount: 3,
      windowBoundsByIndex: WINDOW_BOUNDS,
      windowFrom: WINDOW_BOUNDS[windowIndex as 1 | 2 | 3].from,
      windowTo: WINDOW_BOUNDS[windowIndex as 1 | 2 | 3].to,
      agentAddressByAgentId: { "WORKER-CODE": "0x00000000000000000000000000000000000000cd" },
    });
  }

  it("mint_claim: defaults to the window the buyer is standing in", async () => {
    const args = (await buildToolArgs("mint_claim", { quantity: "500" }, datedCtx(1))) as {
      windowFrom: number;
      windowTo: number;
    };
    expect(args.windowFrom).toBe(Number(WINDOW_BOUNDS[1].from));
    expect(args.windowTo).toBe(Number(WINDOW_BOUNDS[1].to));
  });

  it("mint_claim: a claim dated for a later window gets that window's own real bounds", async () => {
    // The property fSIU is defined by — reserving capacity for a FUTURE delivery window. Without
    // this, a claim is only a slower way to pay for work about to be consumed.
    const args = (await buildToolArgs(
      "mint_claim",
      { quantity: "500", forWindow: 3 },
      datedCtx(1),
    )) as {
      windowFrom: number;
      windowTo: number;
    };
    expect(args.windowFrom).toBe(Number(WINDOW_BOUNDS[3].from));
    expect(args.windowTo).toBe(Number(WINDOW_BOUNDS[3].to));
  });

  it("pay_with_claim: carries the same dating, so paying a counterparty forward is possible too", async () => {
    // Quoted against the print this window attests: a claim is sized at the print the quote names.
    const quoted = boardWithQuote(undefined, "10", "500000", "2026-09-27-commodity");
    const args = (await buildToolArgs(
      "pay_with_claim",
      { requestId: quoted.requestId, forWindow: 2 },
      datedCtx(1, quoted.board),
    )) as { windowFrom: number; windowTo: number };
    expect(args.windowFrom).toBe(Number(WINDOW_BOUNDS[2].from));
    expect(args.windowTo).toBe(Number(WINDOW_BOUNDS[2].to));
  });

  it("mint_claim: refuses a window that does not exist, rather than clamping to one that does", async () => {
    // Clamping would silently retarget a buyer's stated intent; minting against bounds nobody will
    // ever stand in produces a claim that can never be presented. Both are worse than refusing.
    await expect(
      buildToolArgs("mint_claim", { quantity: "500", forWindow: 4 }, datedCtx(1)),
    ).rejects.toThrow(/no window 4/);
  });

  it("mint_claim: refuses a window that has already closed", async () => {
    await expect(
      buildToolArgs("mint_claim", { quantity: "500", forWindow: 1 }, datedCtx(3)),
    ).rejects.toThrow(/already closed/);
  });

  it("mint_claim: in a single-window run, naming another window is refused, not silently ignored", async () => {
    await expect(
      buildToolArgs(
        "mint_claim",
        { quantity: "500", forWindow: 2 },
        baseCtx({
          mintContext: {
            publisherPrivateKeyHex: PUBLISHER_PK,
            printId: "p",
            series: SERIES_COMMODITY,
            printDate: printDateToUnixDay("2026-09-27"),
            nanoUsdPerSiu: 1_433_000n,
            validitySeconds: 3600n,
          },
        }),
      ),
    ).rejects.toThrow(/no window 2/);
  });

  // ----- forward terms

  function forwardCtx(windowIndex: number, book = new ForwardQuoteBook()): BuildToolArgsContext {
    return baseCtx({
      forwardBook: book,
      windowIndex,
      windowCount: 3,
      agentAddressByAgentId: { "ISSUER-A": "0x00000000000000000000000000000000000000a1" },
      caller: {
        agentId: "ISSUER-A",
        erc8004Id: "erc8004:0x00000000000000000000000000000000000000a1",
      },
    });
  }

  it("quote_forward: splices the issuer's own address and the job's class, never the model's", async () => {
    const args = (await buildToolArgs(
      "quote_forward",
      {
        forWindow: 3,
        rateUsdPerSiu: "0.0020",
        maxQuantityMilliSiu: "5000",
        issuerAddress: "0xdead",
        classId: "0xbeef",
      },
      forwardCtx(1),
    )) as { classId: string; issuerAddress: string; forWindow: number };
    // The headroom recorded beside an offer has to be genuinely that issuer's, in the class the
    // work is actually in — so neither field is taken from the model even when it supplies one.
    expect(args.issuerAddress).toBe("0x00000000000000000000000000000000000000a1");
    expect(args.classId).toBe(keccak256(stringToBytes(JOB.taskClass)));
    expect(args.forWindow).toBe(3);
  });

  it("quote_forward: refuses a window that is not later than this one", async () => {
    await expect(
      buildToolArgs(
        "quote_forward",
        { forWindow: 1, rateUsdPerSiu: "0.002", maxQuantityMilliSiu: "1" },
        forwardCtx(1),
      ),
    ).rejects.toThrow(/must be a later window/);
    await expect(
      buildToolArgs(
        "quote_forward",
        { forWindow: 4, rateUsdPerSiu: "0.002", maxQuantityMilliSiu: "1" },
        forwardCtx(1),
      ),
    ).rejects.toThrow(/must be a later window/);
  });

  it("quote_forward: refuses entirely in a single-window run, where there is no later window", async () => {
    await expect(
      buildToolArgs(
        "quote_forward",
        { forWindow: 2, rateUsdPerSiu: "0.002", maxQuantityMilliSiu: "1" },
        baseCtx({ forwardBook: new ForwardQuoteBook(), windowIndex: 1, windowCount: 1 }),
      ),
    ).rejects.toThrow(/only one window/);
  });

  it("take_forward: echoes the real terms from the book rather than the model's restatement", async () => {
    const book = new ForwardQuoteBook();
    const quote = book.record({
      issuer: "ISSUER-A",
      forWindow: 2,
      statedInWindow: 1,
      rateUsdPerSiu: "0.0020",
      maxQuantityMilliSiu: "5000",
      issuerHeadroomAtQuote: "24000",
    });
    const args = (await buildToolArgs(
      "take_forward",
      { quoteId: quote.quoteId },
      forwardCtx(2, book),
    )) as {
      issuer: string;
      rateUsdPerSiu: string;
      maxQuantityMilliSiu: string;
      forWindow: number;
    };
    expect(args).toEqual({
      quoteId: quote.quoteId,
      issuer: "ISSUER-A",
      rateUsdPerSiu: "0.0020",
      maxQuantityMilliSiu: "5000",
      forWindow: 2,
    });
  });

  it("take_forward: refuses an unknown offer, and one already taken", async () => {
    const book = new ForwardQuoteBook();
    await expect(
      buildToolArgs("take_forward", { quoteId: "fwd-404" }, forwardCtx(2, book)),
    ).rejects.toThrow(/no forward offer/);
    const quote = book.record({
      issuer: "ISSUER-B",
      forWindow: 2,
      statedInWindow: 1,
      rateUsdPerSiu: "0.0030",
      maxQuantityMilliSiu: "1000",
      issuerHeadroomAtQuote: "16000",
    });
    book.markTaken(quote.quoteId, "ORCHESTRATOR", 2);
    await expect(
      buildToolArgs("take_forward", { quoteId: quote.quoteId }, forwardCtx(2, book)),
    ).rejects.toThrow(/already taken by ORCHESTRATOR/);
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
              siu: "10",
              model: "claude-sonnet-5",
              rateUsdPerSiu: "0.05",
              indexVersion: "SIU-2026a",
              printId: "2026-09-25",
              printHash: "0xabc",
              sellerId: "erc8004:0xWORKERCODE",
              chain: "base-sepolia",
              expiresInSeconds: 3600,
              pattern: "fixed",
            },
          }),
          usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      }
      return {
        text: JSON.stringify({
          done: true,
          summary: "saw the answered quote, stopping here for this test",
        }),
        usage: { input: 50, output: 10, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      };
    };
    const workerAdapter: Adapter = async () => ({
      text: JSON.stringify({ tool: "issue_quote", args: { requestId: "qr-1" } }),
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
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
      temperature: 0.7,
      provider: "openai",
    };

    const budgetCeiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 5, maxInferenceUsd: "2" },
      "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 5, maxInferenceUsd: "2" },
      "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
    });
    const budget = new ExperimentBudget({
      ceiling: budgetCeiling,
      runCapUsd: "30",
      experimentCapUsd: "150",
      ledgerPath,
    });

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorCfg, workerCfg],
      job: JOB,
      maxTurnsPerAgent: 2,
      budget,
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-board",
      manifest: MANIFEST,
    });

    // WORKER-CODE's own first (and only) turn saw the real, posted request on its own board view.
    expect(result.turnLogsByAgent["WORKER-CODE"][0].marketBoardText).toContain("qr-1");
    expect(result.turnLogsByAgent["WORKER-CODE"][0].marketBoardText).toContain("ORCHESTRATOR");
    // ORCHESTRATOR's second turn saw WORKER-CODE's real, signed answer back.
    expect(result.turnLogsByAgent.ORCHESTRATOR[1].marketBoardText).toContain("qr-1");
    expect(result.turnLogsByAgent.ORCHESTRATOR[1].marketBoardText).toContain(
      "erc8004:0xWORKERCODE",
    );
    // ORCHESTRATOR's first turn (before anything was answered) saw no board at all.
    expect(result.turnLogsByAgent.ORCHESTRATOR[0].marketBoardText).toBeUndefined();
  });
});

describe("runFullRunWindow — the redemption tracker makes a real fSIU claim actually redeemable", () => {
  // Real anvil, real (unmodified) contracts, real chain writes for every mint/transfer/redeem/
  // serve call below — the same devnet WP-5's own dry-loop scenarios use, not a mock. Startup
  // cost is real (~seconds), matching those tests' own generous beforeAll timeout.
  let devnet: DevnetHandle;
  let runsRoot: string;
  let ledgerPath: string;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-redemption-test-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("ISSUER-A only ever sees a pending redemption once mint+present+grade are all real and done, then serves it for real", async () => {
    const rosterConfig = (
      agentId: AgentId,
      adapter: Adapter,
      availableTools: RosterAgentConfig["availableTools"],
    ): RosterAgentConfig => ({
      agentId,
      adapter,
      modelString: "test",
      prices: PRICES,
      skillPackText: CANONICAL_ASSET_DESCRIPTION,
      availableTools,
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      address: devnet.agents[agentId].address,
      erc8004Id: erc8004IdFor(devnet.agents[agentId].address),
      rpcUrl: devnet.rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: "openai",
    });

    const respond = (text: string): AdapterResult => ({
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    let orchestratorCall = 0;
    const orchestratorAdapter: Adapter = async (_model, prompt) => {
      orchestratorCall++;
      if (orchestratorCall === 1) {
        return respond(JSON.stringify({ tool: "mint_claim", args: { quantity: "10" } }));
      }
      if (orchestratorCall === 2) {
        const tokenId = prompt.match(/"tokenId":"(\d+)"/)?.[1];
        expect(tokenId).toBeDefined(); // the real Minted tokenId, learned from turn 1's own real history
        mintedTokenId = tokenId;
        return respond(
          JSON.stringify({
            tool: "transfer_claim",
            args: { agentId: "WORKER-CODE", tokenId, quantity: "10" },
          }),
        );
      }
      return respond(JSON.stringify({ done: true, summary: "minted and transferred" }));
    };

    // WORKER-CODE has no protocol-level way to *discover* the tokenId ORCHESTRATOR mints (there
    // is no cross-agent transfer board, unlike quotes — a real, separate gap, out of scope for
    // this redemption-tracker wiring test). Sharing it here is a test-only simplification of
    // that unsolved discovery problem; what this test verifies instead is real either way — that
    // WORKER-CODE only acts once its own real, on-chain balance for that token is genuinely
    // nonzero, never before.
    //
    // Corrected 2026-09-26 (real role-confusion fix — data/gate-market/
    // first-real-default-2026-09-26.json): WORKER-CODE is the HOLDER here, and redemption grades
    // the ISSUER's own delivery, never the holder's — so WORKER-CODE only presents the claim and
    // then waits; it never calls submit_job for this claim at all.
    let mintedTokenId: string | undefined;
    const workerAdapter: Adapter = async (_model, prompt) => {
      if (!mintedTokenId) {
        return respond(
          JSON.stringify({
            tool: "get_balances",
            args: { account: devnet.agents["WORKER-CODE"].address, tokenIds: [] },
          }),
        );
      }
      const balanceMatch = prompt.match(
        new RegExp(`"tokenId":"${mintedTokenId}","balance":"(\\d+)"`),
      );
      const reallyHoldsClaim = balanceMatch !== null && balanceMatch[1] !== "0";
      if (!reallyHoldsClaim) {
        return respond(
          JSON.stringify({
            tool: "get_balances",
            args: { account: devnet.agents["WORKER-CODE"].address, tokenIds: [mintedTokenId] },
          }),
        );
      }
      const alreadyRedeemed = /called redeem_claim/.test(prompt);
      if (!alreadyRedeemed) {
        const taskSpecHash = keccak256(stringToBytes("gate-hardening:redemption-wiring-test"));
        return respond(
          JSON.stringify({ tool: "redeem_claim", args: { tokenId: mintedTokenId, taskSpecHash } }),
        );
      }
      return respond(
        JSON.stringify({ done: true, summary: "presented, waiting on the issuer to deliver" }),
      );
    };

    // ISSUER-A is the one who now does the real work: waits for "A CLAIM WAS PRESENTED AGAINST
    // YOU", then authors and submits the real, proven-passing gate itself.
    const issuerPrompts: string[] = [];
    const issuerAdapter: Adapter = async (_model, prompt) => {
      issuerPrompts.push(prompt);
      const readyMatch = prompt.match(
        /tokenId (\S+), holder (\S+), quantity (\S+), real graded result: passed=(true|false), receiptRef (\S+)/,
      );
      if (readyMatch) {
        const [, tokenId, holder, quantity, passed, receiptRef] = readyMatch;
        return respond(
          JSON.stringify({
            tool: "serve_redemption",
            args: { tokenId, agentId: holder, quantity, passed: passed === "true", receiptRef },
          }),
        );
      }
      const presentedMatch = /A CLAIM WAS PRESENTED AGAINST YOU/.test(prompt);
      const alreadySubmitted = /called submit_job/.test(prompt);
      if (presentedMatch && !alreadySubmitted) {
        return respond(
          JSON.stringify({ tool: "submit_job", args: { source: CODE_GATE_3_HARDENED.source } }),
        );
      }
      return respond(
        JSON.stringify({ tool: "get_print", args: { printId: "redemption-wiring-test-print" } }),
      );
    };

    const job: JobEnvelope = {
      jobId: "redemption-wiring-test",
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    };

    const mintContext: MintContext = {
      publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
      printId: "redemption-wiring-test-print",
      series: SERIES_COMMODITY,
      printDate: printDateToUnixDay("2026-09-25"),
      nanoUsdPerSiu: 10_000_000n,
      validitySeconds: 3600n,
    };

    const ceiling = new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id) => [
          id,
          { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" },
        ]),
      ) as Record<
        AgentId,
        { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }
      >,
    );
    const budget = new ExperimentBudget({
      ceiling,
      runCapUsd: "1000000",
      experimentCapUsd: "1000000",
      ledgerPath,
    });

    const deps: RunnerDeps = {
      chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
      deployment: devnet.deployment,
      escrowAddress: "0x0000000000000000000000000000000000dead",
      runGateHardeningChecks,
      loadPrint: async () => ({ print_id: "redemption-wiring-test-print" }) as unknown as Print,
      isReconciled: async () => false,
    };

    const result = await runFullRunWindow({
      windowId: "w-redemption",
      roster: [
        rosterConfig("ORCHESTRATOR", orchestratorAdapter, ["mint_claim", "transfer_claim"]),
        rosterConfig("WORKER-CODE", workerAdapter, ["get_balances", "redeem_claim"]),
        rosterConfig("ISSUER-A", issuerAdapter, ["get_print", "submit_job", "serve_redemption"]),
      ],
      job,
      maxTurnsPerAgent: 6,
      budget,
      deps,
      runsRoot,
      runId: "run-redemption",
      manifest: MANIFEST,
      mintContext,
      taskSpecText: "SPEC-CARRIED-WITH-THE-REDEMPTION: dedupeSorted(arr)",
    });

    expect(result.passed).toBe(true);
    expect(result.passedBy).toBe("ISSUER-A"); // the routed issuer delivered — not the holder

    // The spec reached the routed issuer, in its own prompt, as part of the redemption — and only
    // after the claim was actually presented against it. Before 2026-09-29 it reached no issuer at
    // all, so an issuer was told it owed a gate for a job it had never seen.
    const firstSpecIndex = issuerPrompts.findIndex((p) =>
      p.includes("SPEC-CARRIED-WITH-THE-REDEMPTION"),
    );
    expect(firstSpecIndex).toBeGreaterThanOrEqual(0);
    expect(issuerPrompts[0]).not.toContain("SPEC-CARRIED-WITH-THE-REDEMPTION");

    // ISSUER-A never saw a pending redemption until every real fact was actually in. Matched on
    // the tracker's own real, structured line (not the bare phrase "PENDING REDEMPTION ROUTED TO
    // YOU" — that phrase is also named, as a hint, inside serve_redemption's own real tool
    // description shown every turn regardless of tracker state; see tool-descriptions.ts).
    const REDEMPTION_READY_PATTERN =
      /tokenId (\S+), holder (\S+), quantity (\S+), real graded result: passed=(true|false), receiptRef (\S+)/;
    const firstReadyIndex = issuerPrompts.findIndex((p) => REDEMPTION_READY_PATTERN.test(p));
    expect(firstReadyIndex).toBeGreaterThan(-1);
    for (const earlierPrompt of issuerPrompts.slice(0, firstReadyIndex)) {
      expect(REDEMPTION_READY_PATTERN.test(earlierPrompt)).toBe(false);
    }
    expect(issuerPrompts[firstReadyIndex]).toContain("real graded result: passed=true");

    // The real serve_redemption call actually happened and actually succeeded on-chain.
    const issuerRecords = result.turnLogsByAgent["ISSUER-A"];
    const serveTurn = issuerRecords.find((log) => log.parsed.includes("serve_redemption"));
    expect(serveTurn).toBeDefined();
    expect(serveTurn?.parsed).not.toContain("error");

    // And the fSIU claim was genuinely burned by a real, passing serve_redemption — read straight
    // from chain, not asserted from the loop's own bookkeeping.
    const servedTokenId = BigInt(issuerPrompts[firstReadyIndex].match(/tokenId (\S+),/)![1]);
    const holderBalance = await deps.chainReader.claimBalance(
      servedTokenId,
      devnet.agents["WORKER-CODE"].address as Hex,
    );
    expect(holderBalance).toBe(0n); // burned on a genuine pass, same invariant happy-path.ts checks
  }, 90_000);

  it("a holder's own submit_job attempt — even a genuinely passing one — never feeds the redemption tracker, never routes anything to the issuer, and never burns or defaults the claim", async () => {
    // The explicit regression for the real 2026-09-26 incident (data/gate-market/
    // first-real-default-2026-09-26.json): redemption grades the routed ISSUER's own delivery,
    // never the holder's. Here the holder submits the SAME real, proven-passing gate itself —
    // the strongest version of the property, since even a genuine pass from the wrong agent must
    // not count.
    const rosterConfig = (
      agentId: AgentId,
      adapter: Adapter,
      availableTools: RosterAgentConfig["availableTools"],
    ): RosterAgentConfig => ({
      agentId,
      adapter,
      modelString: "test",
      prices: PRICES,
      skillPackText: CANONICAL_ASSET_DESCRIPTION,
      availableTools,
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      address: devnet.agents[agentId].address,
      erc8004Id: erc8004IdFor(devnet.agents[agentId].address),
      rpcUrl: devnet.rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: "openai",
    });
    const respond = (text: string): AdapterResult => ({
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    let orchestratorCall = 0;
    const orchestratorAdapter: Adapter = async () => {
      orchestratorCall++;
      if (orchestratorCall === 1) {
        return respond(JSON.stringify({ tool: "mint_claim", args: { quantity: "10" } }));
      }
      return respond(
        JSON.stringify({ done: true, summary: "minted, not transferring in this test" }),
      );
    };

    // ISSUER-A does nothing but poll — it never receives a delivery-owed prompt because the
    // holder never actually presents (only the issuer's mint-time role is exercised here).
    const issuerPrompts: string[] = [];
    const issuerAdapter: Adapter = async (_model, prompt) => {
      issuerPrompts.push(prompt);
      return respond(
        JSON.stringify({ tool: "get_print", args: { printId: "regression-test-print" } }),
      );
    };

    // A holder who was never transferred anything, presented nothing, yet still attempts the
    // real work directly against this window's own job — the adversarial case the fix must
    // reject regardless of what the holder's own attempt actually produces.
    let attackerCall = 0;
    const attackerAdapter: Adapter = async () => {
      attackerCall++;
      if (attackerCall === 1) {
        return respond(
          JSON.stringify({ tool: "submit_job", args: { source: CODE_GATE_3_HARDENED.source } }),
        );
      }
      return respond(JSON.stringify({ done: true, summary: "attempted the work directly" }));
    };

    const job: JobEnvelope = {
      jobId: "role-confusion-regression-test",
      taskClass: "code",
      originalGate: CODE_GATE_1_TRIVIAL,
      referenceInstance: CODE_REFERENCE,
      knownGoodSubmission: CODE_KNOWN_GOOD,
      adversarialSubmissions: [
        CODE_ADVERSARIAL_ORIGINAL_BUG,
        CODE_ADVERSARIAL_HARDCODED,
        CODE_ADVERSARIAL_STUBBED,
        CODE_ADVERSARIAL_EXCEPTION_SWALLOWING,
      ],
      heldOutInstances: CODE_HELD_OUT_INSTANCES,
    };
    const mintContext: MintContext = {
      publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
      printId: "regression-test-print",
      series: SERIES_COMMODITY,
      printDate: printDateToUnixDay("2026-09-25"),
      nanoUsdPerSiu: 10_000_000n,
      validitySeconds: 3600n,
    };
    const ceiling = new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id) => [
          id,
          { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" },
        ]),
      ) as Record<
        AgentId,
        { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }
      >,
    );
    const budget = new ExperimentBudget({
      ceiling,
      runCapUsd: "1000000",
      experimentCapUsd: "1000000",
      ledgerPath,
    });
    const deps: RunnerDeps = {
      chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
      deployment: devnet.deployment,
      escrowAddress: "0x0000000000000000000000000000000000dead",
      runGateHardeningChecks,
      loadPrint: async () => ({ print_id: "regression-test-print" }) as unknown as Print,
      isReconciled: async () => false,
    };

    const issuerHeadroomBefore = await deps.chainReader.headroom(
      devnet.agents["ISSUER-A"].address as Hex,
      keccak256(stringToBytes("code")),
    );

    const result = await runFullRunWindow({
      windowId: "w-role-confusion-regression",
      roster: [
        rosterConfig("ORCHESTRATOR", orchestratorAdapter, ["mint_claim"]),
        rosterConfig("WORKER-CODE", attackerAdapter, ["submit_job"]),
        rosterConfig("ISSUER-A", issuerAdapter, ["get_print", "serve_redemption"]),
      ],
      job,
      maxTurnsPerAgent: 2,
      budget,
      deps,
      runsRoot,
      runId: "run-role-confusion-regression",
      manifest: MANIFEST,
      mintContext,
    });

    // WORKER-CODE's own submit_job call genuinely passed G1-G6 (a real, proven-passing gate) —
    // the window's own bookkeeping correctly reflects that some agent delivered a real pass...
    expect(result.passed).toBe(true);
    expect(result.passedBy).toBe("WORKER-CODE");
    // ...but that pass must never reach the redemption tracker or the routed issuer, since
    // WORKER-CODE was never the routed issuer for the minted claim. Matched on the tracker's own
    // real, structured lines (not the bare phrase "PENDING REDEMPTION ROUTED TO YOU" — that
    // phrase is also named, as a hint, inside serve_redemption's own real tool description shown
    // every turn regardless of tracker state; see tool-descriptions.ts).
    const REDEMPTION_READY_PATTERN =
      /tokenId (\S+), holder (\S+), quantity (\S+), real graded result: passed=(true|false), receiptRef (\S+)/;
    const DELIVERY_OWED_PATTERN = /tokenId (\S+), holder (\S+), quantity (\S+)\./;
    for (const prompt of issuerPrompts) {
      expect(REDEMPTION_READY_PATTERN.test(prompt)).toBe(false);
      expect(DELIVERY_OWED_PATTERN.test(prompt)).toBe(false);
    }
    expect(
      result.turnLogsByAgent["ISSUER-A"].some((log) => log.parsed.includes("serve_redemption")),
    ).toBe(false);

    // And the real, on-chain consequence: ISSUER-A's real headroom was consumed by the real mint
    // and never restored — no burn, no default draw happened for WORKER-CODE's own unrouted
    // attempt. A holder's own work, however good, moved nothing.
    expect(result.turnsByAgent.ORCHESTRATOR).toBeGreaterThan(0);
    const issuerHeadroomAfter = await deps.chainReader.headroom(
      devnet.agents["ISSUER-A"].address as Hex,
      keccak256(stringToBytes("code")),
    );
    expect(issuerHeadroomAfter).toBeLessThan(issuerHeadroomBefore);
  }, 90_000);
});

/**
 * The span bound, which run comparability rests on and which had no test behind it.
 *
 * Turns used to run until their agents were done rather than until their window ended, so a slow
 * window ate the next one's time: run 10's window 1 overran by ~13 minutes and window 2 opened
 * with 386 seconds of its 1,200-second span. Windows whose real duration depends on how long the
 * previous one took are not comparable to each other, and five comparable F1 runs need them to
 * be.
 *
 * Five lines at the loop head, exactly the shape of the wake gate that starved WORKER-CODE and
 * the window-break that made the dollar route's attack arm unreachable — both five-line changes,
 * both wrong, both found only by running them.
 */
describe("turns are bounded by their window's span", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-span-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("hands out no turns at all when the span has already elapsed", async () => {
    let calls = 0;
    const adapter: Adapter = async () => {
      calls++;
      throw new Error("the adapter must not be called: the window's span is already over");
    };

    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(adapter)],
      job: JOB,
      maxTurnsPerAgent: 5,
      // One hour in the past.
      windowSpanEndsAtUnixSeconds: BigInt(Math.floor(Date.now() / 1000) - 3600),
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-span-elapsed",
      manifest: MANIFEST,
    });

    expect(calls).toBe(0);
    expect(result.turnsByAgent.ORCHESTRATOR).toBe(0);
    expect(result.haltedReason?.ORCHESTRATOR).toBe("window_span_elapsed");
  }, 20_000);

  it("still runs the window normally when the span is open", async () => {
    // The bound must not become the next blocker — the failure mode that made both prior
    // five-line changes wrong. A window with time left behaves exactly as before.
    const result = await runFullRunWindow({
      windowId: "w0",
      roster: [orchestratorConfig(scriptedAdapter(["export async function gate(){ return {accept:true,reason:'ok'}; }"]))],
      job: JOB,
      maxTurnsPerAgent: 2,
      windowSpanEndsAtUnixSeconds: BigInt(Math.floor(Date.now() / 1000) + 3600),
      budget: generousBudget(ledgerPath),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-span-open",
      manifest: MANIFEST,
    });

    expect(result.turnsByAgent.ORCHESTRATOR).toBeGreaterThan(0);
    expect(result.haltedReason?.ORCHESTRATOR).not.toBe("window_span_elapsed");
  }, 30_000);
});

/**
 * **A claim you already hold, settling somebody else's quote.** Real anvil, real contracts, real
 * board.
 *
 * This is the circulation case and it was not expressible until 2026-09-30. `pay_with_claim`
 * MINTS a fresh claim — new issuance, new headroom — so paying with it is not a claim changing
 * hands. Only `transfer_claim` passes on an existing one, and `transfer_claim` could not settle
 * a quote, because `board.recordPaid` was reached from the `pay` branch alone. A seller would
 * have watched a claim arrive while its quote stayed open and it was never told it owed work —
 * the buyer out of pocket, the job undone, which is the failure that cost run 4's window 1.
 */
describe("runFullRunWindow — a held claim settles a quote, and the seller is told", () => {
  let devnet: DevnetHandle;
  let runsRoot: string;
  let ledgerPath: string;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-circulation-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("marks the quote paid when a held claim is transferred to settle it", async () => {
    const cfg = (
      agentId: AgentId,
      adapter: Adapter,
      availableTools: RosterAgentConfig["availableTools"],
    ): RosterAgentConfig => ({
      agentId,
      adapter,
      modelString: "test",
      prices: PRICES,
      skillPackText: CANONICAL_ASSET_DESCRIPTION,
      availableTools,
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      address: devnet.agents[agentId].address,
      erc8004Id: erc8004IdFor(devnet.agents[agentId].address),
      rpcUrl: devnet.rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: "openai",
    });
    const respond = (text: string): AdapterResult => ({
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    let tokenId: string | undefined;
    let orchCall = 0;
    const orchAdapter: Adapter = async (_m, prompt) => {
      orchCall++;
      if (orchCall === 1) return respond(JSON.stringify({ tool: "mint_claim", args: { quantity: "1500" } }));
      if (orchCall === 2) {
        tokenId = prompt.match(/"tokenId":"(\d+)"/)?.[1];
        return respond(
          JSON.stringify({
            tool: "transfer_claim",
            args: { agentId: "WORKER-CODE", tokenId, quantity: "1500" },
          }),
        );
      }
      return respond(JSON.stringify({ done: true, summary: "funded the buyer" }));
    };

    // The buyer: asks WORKER-EXTRACT for a quote, then settles it with the claim it is holding
    // rather than redeeming it or paying dollars.
    const sellerId = erc8004IdFor(devnet.agents["WORKER-EXTRACT"].address);
    let buyerCall = 0;
    const buyerAdapter: Adapter = async (_m, prompt) => {
      buyerCall++;
      if (buyerCall === 1) {
        return respond(
          JSON.stringify({
            tool: "request_quote",
            args: {
              siu: "1", model: "test", rateUsdPerSiu: "0.0100", indexVersion: "SIU-2026a",
              printId: "circulation-test-print", printHash: `0x${"11".repeat(32)}`,
              sellerId, chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
            },
          }),
        );
      }
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      // ORCHESTRATOR transfers on its own turn earlier in the same round, so by the buyer's
      // second turn the claim is genuinely held — the chain write has already happened and
      // transfer_claim would revert otherwise.
      if (requestId !== undefined && tokenId !== undefined) {
        return respond(
          JSON.stringify({
            tool: "transfer_claim",
            args: { agentId: "WORKER-EXTRACT", tokenId, requestId },
          }),
        );
      }
      return respond(
        JSON.stringify({
          tool: "get_balances",
          args: { account: devnet.agents["WORKER-CODE"].address, tokenIds: tokenId ? [tokenId] : [] },
        }),
      );
    };

    const sellerPrompts: string[] = [];
    const sellerAdapter: Adapter = async (_m, prompt) => {
      sellerPrompts.push(prompt);
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      if (requestId && !prompt.includes("YOU HAVE BEEN PAID")) {
        return respond(JSON.stringify({ tool: "issue_quote", args: { requestId } }));
      }
      return respond(JSON.stringify({ tool: "get_print", args: { printId: "circulation-test-print" } }));
    };

    const ceiling = new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id) => [id, { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" }]),
      ) as Record<AgentId, { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }>,
    );

    const result = await runFullRunWindow({
      windowId: "w-circulation",
      roster: [
        cfg("ORCHESTRATOR", orchAdapter, ["mint_claim", "transfer_claim"]),
        cfg("WORKER-CODE", buyerAdapter, ["get_balances", "request_quote", "transfer_claim"]),
        cfg("WORKER-EXTRACT", sellerAdapter, ["issue_quote", "get_print"]),
      ],
      job: JOB,
      maxTurnsPerAgent: 6,
      budget: new ExperimentBudget({ ceiling, runCapUsd: "1000000", experimentCapUsd: "1000000", ledgerPath }),
      deps: {
        chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
        deployment: devnet.deployment,
        escrowAddress: "0x0000000000000000000000000000000000dead",
        runGateHardeningChecks,
        loadPrint: async () => ({ print_id: "circulation-test-print" }) as unknown as Print,
        isReconciled: async () => false,
      },
      runsRoot,
      runId: "run-circulation",
      manifest: MANIFEST,
      mintContext: {
        publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
        printId: "circulation-test-print",
        series: SERIES_COMMODITY,
        printDate: printDateToUnixDay("2026-09-25"),
        nanoUsdPerSiu: 10_000_000n,
        validitySeconds: 3600n,
      },
    });

    // The claim really moved from the holder to the seller.
    const buyerTransfer = result.capacityEvents.find(
      (e) => e.kind === "transfer_claim" && e.agentId === "WORKER-CODE",
    );
    expect(buyerTransfer, "WORKER-CODE must have paid with the claim it held").toBeDefined();

    // And the seller was TOLD which quote the claim settles, in words that are true. This used
    // to assert "YOU HAVE BEEN PAID" — the dollar notice, "real USDC is in escrow in your favour
    // ... settle_escrow" — which is false for a claim (nothing is held in escrow) and which, being
    // un-clearable, would have held the stall guard open for the rest of the window (2026-10-04).
    // The claim's arrival is now told through the holder section, which names the quote.
    expect(
      sellerPrompts.some((p) => p.includes("A WORK CLAIM WAS TRANSFERRED TO YOU")),
      "the seller must learn a claim arrived",
    ).toBe(true);
    expect(
      sellerPrompts.some((p) => /It settles your quote qr-\d+/.test(p)),
      "the seller must learn WHICH quote the transfer settled",
    ).toBe(true);
    expect(
      sellerPrompts.some((p) => p.includes("real USDC is in escrow in your favour")),
      "and must not be told money is in escrow when none is",
    ).toBe(false);

    // And it is recorded as circulation, not as a fresh purchase.
    const journey = summarisePurchases(result).journeys.find((j) => j.tokenId === tokenId);
    expect(journey?.outcome).toBe("passed_onward");

    // The decision rule (D5) is conditioned on whether the agent HELD fSIU it had been given at the
    // moment it paid. The loop's own ledger must therefore show WORKER-CODE holding the claim
    // ORCHESTRATOR handed it when it passed that claim on — recorded BEFORE the transfer's own
    // effect, or the claim being spent would already read as gone.
    const moment = result.paymentMoments.find(
      (m) => m.agentId === "WORKER-CODE" && m.tool === "transfer_claim",
    );
    expect(moment, "the transfer must be recorded as a payment moment").toBeDefined();
    // ORCHESTRATOR funded WORKER-CODE with 1,500 mSIU, enough to cover a $0.01 quote at the $0.01
    // print (1,000 mSIU) — a transfer that names a quote now has to pay it.
    expect(moment?.heldReceivedMilliSiu).toBe("1500");
    // What WORKER-CODE paid is set by the quote, not by the model: the quote's $0.01 price at a
    // $0.01 print is exactly 1,000 mSIU. (The script supplies no quantity at all.)
    expect(buyerTransfer?.quantityMilliSiu).toBe("1000");
    // The transfer says which quote it settled, so a report can tell it from an unkeyed push.
    expect(buyerTransfer?.settlesRequestId).toMatch(/^qr-\d+$/);
    // ORCHESTRATOR's mint cost is recorded from the mint receipt's own USDC transfer: 1,500 mSIU at
    // $0.01/SIU is $0.015 = 15,000 minor units, worked by hand.
    const orchMint = result.capacityEvents.find((e) => e.kind === "mint_claim" && e.agentId === "ORCHESTRATOR");
    expect(orchMint?.mintCostMinorUnits).toBe("15000");
    expect(moment?.asset).toBe("fsiu");
    expect(moment?.requestId).toMatch(/^qr-\d+$/);

    // The quote's own terms travel with the payment, so a run's artefact can answer "what did this
    // buy and at what stated price" without anyone re-deriving it from a board that no longer
    // exists. They are the quote's STATED terms — `quotedUsdMax` is the ceiling the quote allows,
    // not what was finally settled — and every one is a decimal string, never a float.
    expect(moment?.quotedSiu).toBe("1");
    expect(moment?.quoteRateUsdPerSiu).toBe("0.0100");
    expect(moment?.quotedUsdMax).toBeDefined();
    expect(new D(String(moment?.quotedUsdMax)).equals("0.01")).toBe(true);
  }, 180_000);

  it("records what a USDC quote was actually SETTLED for, joined to the payment by its request id", async () => {
    // The seller settles for LESS than the quote's ceiling — a seller may claim less and the rest
    // returns to the payer. A cost built from the quoted ceiling would overstate the dollar route,
    // so the settled amount is recorded, keyed to the quote the payer named.
    const cfg = (
      agentId: AgentId,
      adapter: Adapter,
      availableTools: RosterAgentConfig["availableTools"],
    ): RosterAgentConfig => ({
      agentId,
      adapter,
      modelString: "test",
      prices: PRICES,
      skillPackText: CANONICAL_ASSET_DESCRIPTION,
      availableTools,
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      address: devnet.agents[agentId].address,
      erc8004Id: erc8004IdFor(devnet.agents[agentId].address),
      rpcUrl: devnet.rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: "openai",
    });
    const respond = (text: string): AdapterResult => ({
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });
    // A real, seller-signed quote naming the devnet's own USDC, placed on the board beforehand —
    // `request_quote` can only name the canonical Base Sepolia token, which has no code here.
    const quoteBody = buildQuoteBody({
      siu: "1", model: "test", rateUsdPerSiu: "0.0100", indexVersion: "SIU-2026a",
      printId: "circulation-test-print", printHash: `0x${"11".repeat(32)}`,
      sellerId: erc8004IdFor(devnet.agents["WORKER-CODE"].address),
      chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
    });
    const signedQuote = await signQuote(
      { ...quoteBody, settlement: [{ ...quoteBody.settlement[0], address: devnet.deployment.usdc.address }] },
      devnet.agents["WORKER-CODE"].privateKeyHex,
    );
    const board = new QuoteBoard();
    const posted = board.postRequest("ORCHESTRATOR", quoteBody);
    board.postIssuedQuote(posted.requestId, signedQuote);

    const buyerAdapter: Adapter = async (_m, prompt) => {
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      if (requestId !== undefined) {
        return respond(
          JSON.stringify({ tool: "pay", args: { requestId, settler: "0x0000000000000000000000000000000000000000" } }),
        );
      }
      return respond(JSON.stringify({ tool: "get_balances", args: { account: devnet.agents.ORCHESTRATOR.address } }));
    };
    const sellerAdapter: Adapter = async (_m, prompt) => {
      if (prompt.includes("YOU HAVE BEEN PAID")) {
        return respond(JSON.stringify({ tool: "settle_escrow", args: { actualAmountUsd: "0.0060" } }));
      }
      return respond(JSON.stringify({ tool: "get_balances", args: { account: devnet.agents["WORKER-CODE"].address } }));
    };

    const usdcBalance = async (address: Hex): Promise<bigint> =>
      createPublicClient({ transport: http(devnet.rpcUrl) }).readContract({
        address: devnet.deployment.usdc.address as Hex,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      });
    const payerBefore = await usdcBalance(devnet.agents.ORCHESTRATOR.address);
    const sellerBefore = await usdcBalance(devnet.agents["WORKER-CODE"].address);

    const ceiling = new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id) => [id, { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" }]),
      ) as Record<AgentId, { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }>,
    );
    const result = await runFullRunWindow({
      windowId: "w-usdc-settled",
      roster: [
        cfg("ORCHESTRATOR", buyerAdapter, ["get_balances", "pay"]),
        cfg("WORKER-CODE", sellerAdapter, ["get_balances", "settle_escrow"]),
      ],
      board,
      job: JOB,
      maxTurnsPerAgent: 6,
      budget: new ExperimentBudget({ ceiling, runCapUsd: "1000000", experimentCapUsd: "1000000", ledgerPath }),
      deps: {
        chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
        deployment: devnet.deployment,
        escrowAddress: devnet.escrowAddress,
        runGateHardeningChecks,
        loadPrint: async () => ({ print_id: "circulation-test-print" }) as unknown as Print,
        isReconciled: async () => false,
      },
      runsRoot,
      runId: "run-usdc-settled",
      manifest: MANIFEST,
      mintContext: {
        publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
        printId: "circulation-test-print",
        series: SERIES_COMMODITY,
        printDate: printDateToUnixDay("2026-09-25"),
        nanoUsdPerSiu: 10_000_000n,
        validitySeconds: 3600n,
      },
    });

    // Independent of anything the loop recorded: the PAYER's real net USDC outflow is the settled
    // amount, not the ceiling — it escrowed 10,000 and got 4,000 back. (The seller receives less,
    // 5,970, because the escrow's 0.5% protocol fee comes out of its proceeds; the fSIU route
    // charges the seller no such fee. That is a seller-side difference, and not a buyer's cost.)
    const payerSpent = payerBefore - (await usdcBalance(devnet.agents.ORCHESTRATOR.address));
    expect(payerSpent).toBe(6000n);

    // The fee the report records is the one the contract actually charged: what the seller was paid
    // short of the settled amount, as basis points of it, equals `feeBps` read from the escrow.
    const sellerGained = (await usdcBalance(devnet.agents["WORKER-CODE"].address)) - sellerBefore;
    const observedFeeBps = ((6000n - sellerGained) * 10_000n) / 6000n;
    expect(await new ViemChainReader(devnet.deployment, devnet.rpcUrl).escrowFeeBps(devnet.escrowAddress as Hex)).toBe(
      Number(observedFeeBps),
    );

    expect(result.usdcSettlements).toHaveLength(1);
    const settlement = result.usdcSettlements[0];
    expect(settlement).toMatchObject({
      sellerAgentId: "WORKER-CODE",
      settledMinorUnits: "6000",
      quotedMinorUnits: "10000",
    });
    // …and it joins to the payment that opened the escrow by the quote's request id.
    const payment = result.paymentMoments.find((m) => m.tool === "pay");
    expect(payment?.requestId).toBeDefined();
    expect(settlement.requestId).toBe(payment?.requestId);
  }, 180_000);
});

describe("an issuer that declines to quote forward is not re-asked every turn (spec §4.6s)", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "forward-invite-test-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it(
    "reproduces run 13's window 1: both issuers woke on EVERY turn until the exact turn they " +
      "called quote_forward, and neither took a turn after. The forward invitation sits inside " +
      "boardSectionText, so it drives the wake gate, and it clears only once a quote is recorded " +
      "in forwardBook — so an issuer exercising the permission the prompt grants it ('or you may " +
      "choose not to') is woken again for the rest of the window. A quarter of that window's real " +
      "inference spend went on two agents whose entire output was two forward quotes.",
    async () => {
      const issuerPrompts: string[] = [];
      // Declines, every turn: calls a harmless local tool rather than quote_forward.
      const decliningIssuer: Adapter = async (_model, prompt) => {
        issuerPrompts.push(prompt);
        return {
          text: JSON.stringify({ tool: "whoami", args: {} }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      const ceiling = new BudgetCeiling({
        "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 8, maxInferenceUsd: "2" },
        "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 8, maxInferenceUsd: "2" },
        "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      });

      await runFullRunWindow({
        windowId: "w-forward-invite",
        roster: [
          // Leaves on its own first turn. A PASSING gate ends the window instantly unless a
          // claim is outstanding or an untested gate remains (see the `someoneCanAttack` guard),
          // and that would end the window before the issuer ever reached a cursor — which is
          // what the first draft of this test did, and why the guard assertion below is here.
          orchestratorConfig(async () => ({
            text: JSON.stringify({ done: true, summary: "nothing for me here" }),
            usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
            latency_ms: 1,
            raw: {},
            deviations: [],
          })),
          {
            agentId: "ISSUER-A",
            adapter: decliningIssuer,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            availableTools: ["whoami", "quote_forward"] as const,
            waitsFor: "inbox" as const,
            privateKeyHex:
              "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 8,
        // Window 1 OF 3. Without this the window is its own last, and the 2026-10-01 rule
        // correctly builds no invitation at all — which is the other half of the fix and is
        // covered by its own test below.
        windowIndex: 1,
        windowCount: 3,
        budget: new ExperimentBudget({
          ceiling,
          runCapUsd: "30",
          experimentCapUsd: "150",
          ledgerPath,
        }),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-forward-invite",
        manifest: MANIFEST,
      });

      // The issuer really was woken and really was invited — otherwise this proves nothing.
      expect(issuerPrompts.length).toBeGreaterThan(0);
      const invited = issuerPrompts.filter((p) => p.includes("FORWARD TERMS"));
      expect(invited.length).toBeGreaterThan(0);

      // The assertion that fails against run 13's behaviour. An issuer that has been told once
      // that it may quote, and did not, has declined. Asking again is not a neutral re-offer:
      // it is the only move that stops the asking, so re-asking manufactures the quote it
      // then reports as a signal (§4.6f, fsiu-design §5.4a-i).
      expect(invited.length).toBe(1);
    },
  );
});

describe("the last-window rule lives in the loop, not only in the roster (spec §4.6s)", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "forward-lastwindow-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it(
    "never invites an issuer to quote forward in the FINAL window, even when the roster hands " +
      "it the tool. buildToolArgs throws for any forWindow <= windowIndex, so every such call " +
      "fails; until 2026-10-01 the loop agreed only because p5's roster happens to drop " +
      "quote_forward when isLastWindow. Two invariants held together by coincidence — grant the " +
      "tool in a final window, which is a one-line roster change nobody would question, and the " +
      "loop would invite the issuer every turn to call a tool that cannot succeed (§4.6o, §4.6v).",
    async () => {
      const prompts: string[] = [];
      const issuer: Adapter = async (_m, prompt) => {
        prompts.push(prompt);
        return {
          text: JSON.stringify({ tool: "whoami", args: {} }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      const ceiling = new BudgetCeiling({
        "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 8, maxInferenceUsd: "2" },
        "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 8, maxInferenceUsd: "2" },
        "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      });

      const result = await runFullRunWindow({
        windowId: "w-last",
        roster: [
          orchestratorConfig(async () => ({
            text: JSON.stringify({ done: true, summary: "nothing for me here" }),
            usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
            latency_ms: 1,
            raw: {},
            deviations: [],
          })),
          {
            agentId: "ISSUER-A",
            adapter: issuer,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            // Deliberately granted in the final window — the thing the roster currently avoids.
            availableTools: ["whoami", "quote_forward"] as const,
            waitsFor: "inbox" as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 8,
        windowIndex: 3,
        windowCount: 3, // the last window
        budget: new ExperimentBudget({ ceiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath }),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-last-window",
        manifest: MANIFEST,
      });

      expect(prompts.some((p) => p.includes("FORWARD TERMS"))).toBe(false);
      // And it must not have been woken at all: an agent with an empty board and no invitation
      // has nothing to act on, which is exactly what run 13's window 3 showed live.
      expect(prompts).toHaveLength(0);
      expect(result.haltedReason?.["ISSUER-A"]).toBe("nothing_to_act_on");
    },
  );
});

describe("the attack-round cap is visible to the thing that spends turns (spec §4.6v)", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "attack-cap-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it(
    "stops waking the adversary once MAX_ATTACK_ROUNDS forbids the newest version. Run 13 " +
      "window 2: WORKER-EXTRACT took TEN turns, every one a distinct submit_attack, and four " +
      "were scored — the cap had been reached by versions 1-3, so once a v4 arrived every " +
      "later call threw. The cap's own comment says it exists so the adversary 'cannot spend " +
      "the whole run's budget on itself'; it spent six turns and $0.185 hitting it, because " +
      "neither the wake gate nor the stall check consults it.",
    async () => {
      let authored = 0;
      const author: Adapter = async () => ({
        // A fresh version every time, so the newest is always one the cap forbids testing.
        text: JSON.stringify({
          tool: "submit_job",
          args: { source: `export async function gate(){ return {accept:true,reason:'v${++authored}'}; }` },
        }),
        usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
        latency_ms: 1,
        raw: {},
        deviations: [],
      });

      const attacks: number[] = [];
      const adversary: Adapter = async () => {
        attacks.push(attacks.length + 1);
        return {
          text: JSON.stringify({
            tool: "submit_attack",
            args: { submissionSource: `export function f(){ return ${attacks.length}; }` },
          }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      const ceiling = new BudgetCeiling({
        "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 12, maxInferenceUsd: "3" },
        "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 12, maxInferenceUsd: "3" },
        HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      });

      const result = await runFullRunWindow({
        windowId: "w-attack-cap",
        roster: [
          orchestratorConfig(author),
          {
            agentId: "WORKER-EXTRACT",
            adapter: adversary,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            availableTools: ["submit_attack"] as const,
            waitsFor: "gate" as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 12,
        budget: new ExperimentBudget({ ceiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath }),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-attack-cap",
        manifest: MANIFEST,
      });

      // The cap really did bind — otherwise this test proves nothing about the cap.
      expect(result.attacks.length).toBeLessThanOrEqual(MAX_ATTACK_ROUNDS);
      // The adversary must not have been given turns it could not use. Allow the scored attacks
      // plus one cursor of slack; run 13 spent SIX turns past this point.
      expect(attacks.length).toBeLessThanOrEqual(MAX_ATTACK_ROUNDS + 1);
    },
  );
});

describe("an agent can declare a wait, and is then left alone (spec §4.6x, §4.6ac)", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "wait-primitive-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it(
    "stops waking an agent that said it is waiting, while nothing actionable changes. The " +
      "response protocol promises 'you are given a turn only when something has genuinely " +
      "arrived for you to act on' — which is FALSE for a buyer that has not purchased, because " +
      "buyerIdle requires hasPurchased. Run 15: WORKER-CODE was woken on all 10 turns of all 3 " +
      "windows and spent 8 of each on check_delivery, asking whether the thing it was promised " +
      "it would be told about had happened.",
    async () => {
      const prompts: string[] = [];
      // Declares a wait on its first turn and would poll forever after, if asked again.
      const waiter: Adapter = async (_m, prompt) => {
        prompts.push(prompt);
        return {
          text: JSON.stringify({ wait: true, summary: "nothing to act on; waiting" }),
          usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
          latency_ms: 1,
          raw: {},
          deviations: [],
        };
      };

      const ceiling = new BudgetCeiling({
        "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 10, maxInferenceUsd: "2" },
        "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 10, maxInferenceUsd: "2" },
        "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      });

      const result = await runFullRunWindow({
        windowId: "w-wait",
        roster: [
          // Leaves immediately: a PASSING gate ends the window before WORKER-CODE reaches a
          // cursor, which is how the first draft of this test measured nothing.
          orchestratorConfig(async () => ({
            text: JSON.stringify({ done: true, summary: "nothing for me here" }),
            usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
            latency_ms: 1,
            raw: {},
            deviations: [],
          })),
          {
            agentId: "WORKER-CODE",
            adapter: waiter,
            modelString: "test",
            prices: PRICES,
            skillPackText: CANONICAL_ASSET_DESCRIPTION,
            availableTools: ["check_delivery", "get_balances"] as const,
            waitsFor: "buyer" as const,
            privateKeyHex: "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a",
            address: "0x0000000000000000000000000000000000000002",
            erc8004Id: "erc8004:0x0000000000000000000000000000000000000002",
            rpcUrl: "http://127.0.0.1:1",
            maxOutputTokens: 3000,
            temperature: 0.7,
            provider: "openai",
          },
        ],
        job: JOB,
        maxTurnsPerAgent: 10,
        budget: new ExperimentBudget({ ceiling, runCapUsd: "30", experimentCapUsd: "150", ledgerPath }),
        deps: fakeDeps(async () => PASS),
        runsRoot,
        runId: "run-wait",
        manifest: MANIFEST,
      });

      // It declared the wait once. Being asked again, with nothing changed, is the defect —
      // and costs a turn and real inference every time it happens.
      expect(prompts).toHaveLength(1);
      // And it must have been UNDERSTOOD, not merely unparseable. Today `{"wait": true}` is not
      // a recognised response, so the agent is removed on a parse_error and the prompt count
      // would be 1 for entirely the wrong reason — this is what distinguishes the fix from the
      // bug it replaces.
      expect(result.haltedReason?.["WORKER-CODE"]).toBe("waiting");
    },
  );
});


describe("composeBoard — what an agent is shown vs what wakes it (spec §4.6ae)", () => {
  /** A grant holding every tool, so a test about composition is not also a test about grants. */
  const ALL_TOOLS = [...new Set(Object.values(WAKE_SECTION_TOOLS).flat())];
  const empty: BoardSections = {
    marketBoardText: "",
    redemptionText: "",
    transferText: "",
    deliveryOwedText: "",
    settleableText: "",
    servedText: "",
    servedWasFailure: false,
    unservedText: "",
    lapsingText: "",
    deliveredGateText: "",
    gateDefeatedText: "",
    forwardInvitation: "",
  };

  it("shows a served PASS without waking on it — the assertion the old single string could not satisfy", () => {
    // Until 2026-10-02 there was ONE string doing both jobs, so `shown` and `wakeKey` were the
    // same value by construction and this expectation was unsatisfiable. That fusion is why a
    // holder was told nothing: the only way to tell it anything was to spend its turn, so §4.6ac
    // kept the channel shut. Run 16's holder slept through its own undelivered claim as a
    // result.
    const { shown, wakeKey } = composeBoard(
      { ...empty, servedText: "YOUR CLAIM WAS SERVED\n  The work passed.", servedWasFailure: false },
      ALL_TOOLS,
    );
    expect(shown).toContain("YOUR CLAIM WAS SERVED");
    expect(wakeKey).toBe("");
    expect(shown).not.toBe(wakeKey);
  });

  it("wakes on a served FAIL, because buying again is a real action and the window is running", () => {
    const { shown, wakeKey } = composeBoard(
      { ...empty, servedText: "YOUR CLAIM WAS SERVED, AND THE WORK DID NOT PASS", servedWasFailure: true },
      ALL_TOOLS,
    );
    expect(shown).toContain("DID NOT PASS");
    expect(wakeKey).toContain("DID NOT PASS");
  });

  it("wakes on an overdue claim", () => {
    const { wakeKey } = composeBoard(
      { ...empty, unservedText: "A CLAIM YOU PRESENTED IS STILL UNSERVED" },
      ALL_TOOLS,
    );
    expect(wakeKey).toContain("STILL UNSERVED");
  });

  it("wakes on nothing when there is nothing — an empty board is still an empty wake key", () => {
    const { shown, wakeKey } = composeBoard(empty, ALL_TOOLS);
    expect(shown).toBe("");
    expect(wakeKey).toBe("");
  });

  it("keeps every other section's wake behaviour exactly as it was", () => {
    // The split must not quietly change which of the pre-existing sections wake an agent.
    for (const key of [
      "marketBoardText",
      "redemptionText",
      "transferText",
      "deliveryOwedText",
      "settleableText",
      "deliveredGateText",
      "gateDefeatedText",
      "forwardInvitation",
    ] as const) {
      const { shown, wakeKey } = composeBoard({ ...empty, [key]: `TEXT-${key}` }, ALL_TOOLS);
      expect(shown).toBe(`TEXT-${key}`);
      expect(wakeKey).toBe(`TEXT-${key}`);
    }
  });

  it("does not wake an agent that cannot act on the section, however real the news", () => {
    // Found by the roster invariant test on its first run: WORKER-EXTRACT can hold and redeem a
    // claim and holds no purchase tool whatsoever, so a served FAIL is real news it can do
    // nothing with. Showing it is right; spending its turn on it is §4.6ac returning.
    const noPurchaseTools = ["submit_attack", "redeem_claim", "settle_window_close"] as const;
    const { shown, wakeKey } = composeBoard(
      { ...empty, servedText: "YOUR CLAIM WAS SERVED, AND THE WORK DID NOT PASS", servedWasFailure: true },
      noPurchaseTools,
    );
    expect(shown).toContain("DID NOT PASS");
    expect(wakeKey).toBe("");
  });

  it("still wakes that same agent on an overdue claim, which it CAN act on", () => {
    // The gate is per section and per grant, not a blanket exclusion: WORKER-EXTRACT holds
    // settle_window_close, so the default that pays it is genuinely actionable.
    const { wakeKey } = composeBoard(
      { ...empty, unservedText: "A CLAIM YOU PRESENTED IS STILL UNSERVED" },
      ["submit_attack", "redeem_claim", "settle_window_close"],
    );
    expect(wakeKey).toContain("STILL UNSERVED");
  });

  it("parks a waiting agent against the key it will SEE next turn, not the one it was shown", () => {
    // Spec §4.6ah, observed twice in run 17. The overdue warning is suppressed the moment it is
    // delivered, so an agent parked against the key it was SHOWN is woken again on the next
    // pass — by the warning's disappearance — with nothing to act on. 22s and 68s after being
    // told, in windows 2 and 3. This assertion is the one the old single-key version could not
    // satisfy: wakeKey and wakeKeyNext were the same value.
    const { wakeKey, wakeKeyNext } = composeBoard(
      { ...empty, unservedText: "OVERDUE", marketBoardText: "A QUOTE" },
      ALL_TOOLS,
    );
    expect(wakeKey).toContain("OVERDUE");
    expect(wakeKeyNext).not.toContain("OVERDUE");
    // The persistent section stays in both — only what the act of showing destroys is dropped.
    expect(wakeKeyNext).toContain("A QUOTE");
  });

  it("applies that to EVERY one-shot section, not only the newest one", () => {
    // gateDefeatedText is bounded by shownGateDefeats and the forward invitation by
    // forwardInvitations; both are suppressed once shown and both had the same latent defect.
    for (const key of ["unservedText", "lapsingText", "gateDefeatedText", "forwardInvitation"] as const) {
      const { wakeKey, wakeKeyNext } = composeBoard({ ...empty, [key]: `TEXT-${key}` }, ALL_TOOLS);
      expect(wakeKey, `${key} should wake`).toBe(`TEXT-${key}`);
      expect(wakeKeyNext, `${key} is one-shot and must not park an agent`).toBe("");
    }
  });

  it("keeps persistent sections in the parked key, or a waiting agent never wakes again", () => {
    // The mirror risk: drop too much and an agent parked against "" sleeps through a real
    // arrival, because the empty key keeps matching.
    for (const key of ["marketBoardText", "redemptionText", "transferText", "deliveryOwedText", "settleableText", "deliveredGateText"] as const) {
      const { wakeKeyNext } = composeBoard({ ...empty, [key]: `TEXT-${key}` }, ALL_TOOLS);
      expect(wakeKeyNext, `${key} is persistent and must stay in the parked key`).toBe(`TEXT-${key}`);
    }
  });

  it("§4.6ac invariant: every section that can wake names at least one tool it is about", () => {
    // The guarantee §4.6ac exists to keep: an agent given a turn must have something it can do.
    // A section with no tool behind it is information without affordance, which is the forced
    // choice returning. Asserted structurally rather than by looking for tool names in the
    // prose — §4.6q, worked syntax for one option is a steer, and the holder's sections are read
    // by a buyer whose asset choice F1 is measuring.
    const wakingSections = Object.keys(empty).filter((k) => k !== "servedWasFailure");
    for (const section of wakingSections) {
      const tools = WAKE_SECTION_TOOLS[section];
      expect(tools, `${section} has no entry in WAKE_SECTION_TOOLS`).toBeDefined();
      expect(tools?.length ?? 0, `${section} maps to no tool`).toBeGreaterThan(0);
    }
  });

  it("§4.6ac invariant: the mapping covers every section and invents none", () => {
    const sections = new Set(Object.keys(empty).filter((k) => k !== "servedWasFailure"));
    expect(new Set(Object.keys(WAKE_SECTION_TOOLS))).toEqual(sections);
  });
});


describe("renderSettleableText — what settling actually pays (fsiu-design.md §4.3a)", () => {
  const claim = (everPresented: boolean | undefined) => ({
    tokenId: "77",
    holder: "0xholder",
    holderAgentId: "WORKER-CODE" as const,
    issuerAgentId: "ISSUER-A" as const,
    quantityMilliSiu: "10000",
    mintedInWindow: 1,
    ...(everPresented === undefined ? {} : { everPresented }),
  });

  it("does not promise a bond payment on a claim that was never presented", () => {
    // The assertion run 17 needed and nobody had written. The old text said, of every claim,
    // "defaults against its own issuer's bond, paying the holder". WORKER-EXTRACT read that,
    // settled an unpresented claim "as instructed", and burned 10,000 mSIU belonging to another
    // agent: Expired, not Defaulted, and nobody paid.
    const text = renderSettleableText([claim(false)], true);
    expect(text).toMatch(/NEVER PRESENTED/);
    expect(text).toMatch(/pays nobody/);
  });

  it("does promise it on a presented one, because there the bond really does pay", () => {
    const text = renderSettleableText([claim(true)], true);
    expect(text).toMatch(/PRESENTED, so settling it draws on the bond and pays its holder/);
  });

  it("tells both stories whenever both kinds are outstanding at once", () => {
    // Run 17 had exactly this: one of each, under one heading, with opposite consequences.
    const text = renderSettleableText([claim(true), { ...claim(false), tokenId: "78" }], true);
    expect(text).toMatch(/presented and then not served: it defaults/);
    expect(text).toMatch(/never presented: it simply expires/);
  });

  it("says it does not know rather than guessing, when the run never saw the claim's history", () => {
    const text = renderSettleableText([claim(undefined)], true);
    expect(text).toMatch(/cannot tell whether it was presented/);
    expect(text).not.toMatch(/NEVER PRESENTED|draws on the bond/);
  });

  it("says nothing to an agent that cannot settle, and nothing when nothing is outstanding", () => {
    expect(renderSettleableText([claim(true)], false)).toBe("");
    expect(renderSettleableText([], true)).toBe("");
  });
});

describe("adversarial testing is a service somebody buys (single-issuer plan, W1b)", () => {
  let runsRoot: string;
  let ledgerPath: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "testing-purchase-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const KEY = "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a";
  const reply = (obj: unknown): AdapterResult => ({
    text: JSON.stringify(obj),
    usage: { input: 100, output: 20, cached_input: 0, reasoning: 0 },
    latency_ms: 1,
    raw: {},
    deviations: [],
  });
  const seat = (
    agentId: AgentId,
    n: number,
    adapter: Adapter,
    availableTools: RosterAgentConfig["availableTools"],
    waitsFor?: RosterAgentConfig["waitsFor"],
  ): RosterAgentConfig => ({
    agentId,
    adapter,
    modelString: "test",
    prices: PRICES,
    skillPackText: CANONICAL_ASSET_DESCRIPTION,
    availableTools,
    ...(waitsFor ? { waitsFor } : {}),
    privateKeyHex: KEY,
    address: `0x000000000000000000000000000000000000000${n}`,
    erc8004Id: `erc8004:0x000000000000000000000000000000000000000${n}`,
    rpcUrl: "http://127.0.0.1:1",
    maxOutputTokens: 3000,
    temperature: 0.7,
    provider: "openai",
  });
  const budget = () =>
    new ExperimentBudget({
      ceiling: new BudgetCeiling({
        "ISSUER-A": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        "ISSUER-B": { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
        ORCHESTRATOR: { maxUsdcSpend: "0", maxInferenceTurns: 12, maxInferenceUsd: "3" },
        "WORKER-CODE": { maxUsdcSpend: "0", maxInferenceTurns: 12, maxInferenceUsd: "3" },
        "WORKER-EXTRACT": { maxUsdcSpend: "0", maxInferenceTurns: 12, maxInferenceUsd: "3" },
        HEDGER: { maxUsdcSpend: "0", maxInferenceTurns: 0, maxInferenceUsd: "0" },
      }),
      runCapUsd: "30",
      experimentCapUsd: "150",
      ledgerPath,
    });

  async function run(opts: { requireTestingPurchase?: boolean }) {
    let wcCalls = 0;
    const author: Adapter = async () =>
      reply({
        tool: "submit_job",
        args: { source: "export async function gate(){ return {accept:true,reason:'v1'}; }" },
      });
    const adversary: Adapter = async () =>
      reply({ tool: "submit_attack", args: { submissionSource: "export function f(){ return 1; }" } });
    // The buyer of testing. It declines on its first turn — the point of the test is whether it
    // is GIVEN that turn at all once a gate has passed, and what the window then counts as.
    const buyer: Adapter = async () => {
      wcCalls += 1;
      return reply({ done: true, summary: "declined" });
    };
    const result = await runFullRunWindow({
      windowId: "w-testing",
      roster: [
        seat("ORCHESTRATOR", 1, author, ["submit_job"]),
        seat("WORKER-CODE", 3, buyer, ["request_quote", "get_balances"], "buyer"),
        seat("WORKER-EXTRACT", 2, adversary, ["submit_attack"], "gate"),
      ],
      job: JOB,
      maxTurnsPerAgent: 6,
      budget: budget(),
      deps: fakeDeps(async () => PASS),
      runsRoot,
      runId: "run-testing",
      manifest: MANIFEST,
      ...opts,
    });
    return { result, wcCalls };
  }

  it("refuses an attack nobody paid for, and does not count the window as passed", async () => {
    // Before this, submit_attack had no payment check at all (its four throws were argument
    // validation) and WORKER-EXTRACT woke the moment a gate existed. The 4,000 mSIU "attack
    // testing" quote was a tip for a service rendered anyway, which is why WORKER-CODE has never
    // bought in any run. A purchase that changes nothing is not a decision.
    const { result } = await run({ requireTestingPurchase: true });
    expect(result.attacks, "an unpaid attack must not execute").toHaveLength(0);
    expect(result.gateDelivered).toBe(true);
    expect(result.testingEngaged).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.incompleteBecause).toBe("testing_never_purchased");
  });

  it("keeps the window open after a gate passes, so the buyer is actually given the chance to buy", async () => {
    // The window breaks the instant a gate passes unless something else holds it open. Today
    // that something is the free adversary (`canAttackNow`), so this passes against the old code
    // too — it is a regression guard, not a fail-first test. Once testing must be bought,
    // `canAttackNow` is false until it is, and without an explicit hold the window would end
    // before the one agent able to buy had a turn, turning "declined" and "never asked" into the
    // same silence: the §4.6y mistake on the buyer's side.
    const { wcCalls } = await run({ requireTestingPurchase: true });
    expect(wcCalls, "the buyer of testing must get a turn after the gate passes").toBeGreaterThanOrEqual(1);
  });

  it("changes nothing for a window that does not require the purchase", async () => {
    // Every other caller — P4's single agent, the dry-loop tests — has no testing market and must
    // keep exactly the old meaning of `passed`: the attack runs unpaid, and a delivered gate is a
    // passed window with no reason attached.
    //
    // NB this once also asserted that the buyer gets NO turn when the option is off. That was a
    // fixture built from an assumption about the code (§4.6ai): the old loop already held the
    // window open for an untested gate, because the adversary was free, so the buyer did get a
    // turn. The hold-open guard above passes against the old code for the same reason.
    const { result } = await run({});
    expect(result.attacks.length).toBeGreaterThan(0);
    expect(result.gateDelivered).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.incompleteBecause).toBeUndefined();
  });
});

/**
 * **The positive path of the testing purchase: a real quote, settled with a real claim, unlocks a
 * real attack, and only then does the window pass.** Real anvil, real contracts, real board.
 *
 * The negative path (an unpaid attack is refused) and the pure pieces are tested without a chain.
 * This is the one that needs one, because engagement is detected from `board.isPaid` after a real
 * settlement, and the wake gate, the delivered-gate section and the hold-open all key off it.
 * The asset is a held claim passed on with `transfer_claim` — deliberately not dollars, because
 * the choice of asset staying free is part of the decision and one asset's path proves nothing
 * about the other's.
 */
describe("runFullRunWindow — a settled testing quote unlocks the attack, and only then does the window pass", () => {
  let devnet: DevnetHandle;
  let runsRoot: string;
  let ledgerPath: string;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);
  afterAll(async () => {
    await devnet.stop();
  });
  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "full-run-testing-"));
    ledgerPath = path.join(runsRoot, "ledger.json");
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("runs the attack after the quote is settled in claims, and counts the window as passed", async () => {
    const cfg = (
      agentId: AgentId,
      adapter: Adapter,
      availableTools: RosterAgentConfig["availableTools"],
      waitsFor?: RosterAgentConfig["waitsFor"],
    ): RosterAgentConfig => ({
      agentId,
      adapter,
      modelString: "test",
      prices: PRICES,
      skillPackText: CANONICAL_ASSET_DESCRIPTION,
      availableTools,
      ...(waitsFor ? { waitsFor } : {}),
      privateKeyHex: devnet.agents[agentId].privateKeyHex,
      address: devnet.agents[agentId].address,
      erc8004Id: erc8004IdFor(devnet.agents[agentId].address),
      rpcUrl: devnet.rpcUrl,
      maxOutputTokens: 3000,
      temperature: 0.7,
      provider: "openai",
    });
    const respond = (text: string): AdapterResult => ({
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    });

    let tokenId: string | undefined;
    let orchCall = 0;
    // Funds the buyer with a claim, then authors the gate. Its role in this test is only to put a
    // passing gate and a claim into the world; the decision under test is the buyer's.
    const orchAdapter: Adapter = async (_m, prompt) => {
      orchCall++;
      if (orchCall === 1) return respond(JSON.stringify({ tool: "mint_claim", args: { quantity: "1500" } }));
      if (orchCall === 2) {
        tokenId = prompt.match(/"tokenId":"(\d+)"/)?.[1];
        return respond(
          JSON.stringify({ tool: "transfer_claim", args: { agentId: "WORKER-CODE", tokenId, quantity: "1500" } }),
        );
      }
      if (orchCall === 3) {
        return respond(
          JSON.stringify({
            tool: "submit_job",
            args: { source: "export async function gate(){ return {accept:true,reason:'v1'}; }" },
          }),
        );
      }
      return respond(JSON.stringify({ done: true, summary: "gate delivered" }));
    };

    const sellerId = erc8004IdFor(devnet.agents["WORKER-EXTRACT"].address);
    let buyerCall = 0;
    const buyerAdapter: Adapter = async (_m, prompt) => {
      buyerCall++;
      if (buyerCall === 1) {
        return respond(
          JSON.stringify({
            tool: "request_quote",
            args: {
              siu: "1", model: "test", rateUsdPerSiu: "0.0100", indexVersion: "SIU-2026a",
              printId: "testing-test-print", printHash: `0x${"11".repeat(32)}`,
              sellerId, chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
            },
          }),
        );
      }
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      if (requestId !== undefined && tokenId !== undefined) {
        return respond(
          JSON.stringify({
            tool: "transfer_claim",
            args: { agentId: "WORKER-EXTRACT", tokenId, requestId },
          }),
        );
      }
      return respond(JSON.stringify({ done: true, summary: "nothing to buy" }));
    };

    const sellerPrompts: string[] = [];
    const sellerAdapter: Adapter = async (_m, prompt) => {
      sellerPrompts.push(prompt);
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      // Answers a request when there is one, attacks only when it has been given a gate to
      // attack, and otherwise waits — it must not be able to attack by guessing.
      if (prompt.includes("A GATE HAS BEEN DELIVERED AND YOU HAVE NOT TESTED IT")) {
        return respond(
          JSON.stringify({ tool: "submit_attack", args: { submissionSource: "export function f(){ return 1; }" } }),
        );
      }
      if (requestId && prompt.includes("Open quote requests addressed to you")) {
        return respond(JSON.stringify({ tool: "issue_quote", args: { requestId } }));
      }
      return respond(JSON.stringify({ wait: true }));
    };

    const ceiling = new BudgetCeiling(
      Object.fromEntries(
        AGENT_IDS.map((id) => [id, { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" }]),
      ) as Record<AgentId, { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }>,
    );

    const result = await runFullRunWindow({
      windowId: "w-testing-paid",
      roster: [
        cfg("ORCHESTRATOR", orchAdapter, ["mint_claim", "transfer_claim", "submit_job"]),
        cfg("WORKER-CODE", buyerAdapter, ["get_balances", "request_quote", "transfer_claim"], "buyer"),
        cfg("WORKER-EXTRACT", sellerAdapter, ["issue_quote", "submit_attack", "get_print"], "gate"),
      ],
      job: JOB,
      maxTurnsPerAgent: 8,
      requireTestingPurchase: true,
      budget: new ExperimentBudget({ ceiling, runCapUsd: "1000000", experimentCapUsd: "1000000", ledgerPath }),
      deps: {
        chainReader: new ViemChainReader(devnet.deployment, devnet.rpcUrl),
        deployment: devnet.deployment,
        escrowAddress: "0x0000000000000000000000000000000000dead",
        runGateHardeningChecks: async () => PASS,
        loadPrint: async () => ({ print_id: "testing-test-print" }) as unknown as Print,
        isReconciled: async () => false,
      },
      runsRoot,
      runId: "run-testing-paid",
      manifest: MANIFEST,
      mintContext: {
        publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
        printId: "testing-test-print",
        series: SERIES_COMMODITY,
        printDate: printDateToUnixDay("2026-09-25"),
        nanoUsdPerSiu: 10_000_000n,
        validitySeconds: 3600n,
      },
    });

    expect(result.testingEngaged, "the settled quote must count as engagement").toBe(true);
    expect(result.attacks.length, "and the attack must then have run").toBeGreaterThan(0);
    expect(result.gateDelivered).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.incompleteBecause).toBeUndefined();
    // The adversary was not shown a gate to attack until it had been paid — the section is gated
    // on engagement, so it cannot be woken by a gate alone.
    const firstGateShown = sellerPrompts.findIndex((p) =>
      p.includes("A GATE HAS BEEN DELIVERED AND YOU HAVE NOT TESTED IT"),
    );
    const firstPaidShown = sellerPrompts.findIndex((p) => /It settles your quote qr-\d+/.test(p));
    expect(firstGateShown).toBeGreaterThanOrEqual(0);
    if (firstPaidShown >= 0) expect(firstPaidShown).toBeLessThanOrEqual(firstGateShown);
  }, 180_000);
});
