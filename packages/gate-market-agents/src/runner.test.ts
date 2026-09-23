import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { Runner, ToolNotAllowedError } from "./runner.js";
import type { ToolName } from "./tools/index.js";
import { BudgetCeiling, CeilingExceededError } from "./budget/ceiling.js";
import { assembleContext, serializeContext } from "./context/assemble.js";
import type { RunnerDeps } from "./deps.js";
import type { ChainReader } from "./chain/reader.js";
import type { GateMarketDeployment } from "./chain/deployment.js";

// A real, syntactically valid secp256k1 test key — deliberately NOT a placeholder like
// "0x000...0" or "0xabc...", since the regression test below must prove this exact hex string
// never appears anywhere in an assembled AgentContext. Test-only; holds no real funds.
const TEST_PRIVATE_KEY = "0x7ea2a69f7b42fd0a1d3e901cac8d37e76a96075b663fa5f56950bf009c49f44b";

function fakeDeployment(): GateMarketDeployment {
  return {
    network: { name: "test", chainId: 0 },
    usdc: { address: "0x0000000000000000000000000000000000dead" },
    capacityBond: { address: "0x0000000000000000000000000000000000dea1" },
    claimRouter: { address: "0x0000000000000000000000000000000000dea2" },
    workClaim: { address: "0x0000000000000000000000000000000000dea3" },
  };
}

function fakeChainReader(): ChainReader {
  return {
    usdcBalance: async () => 0n,
    claimBalance: async () => 0n,
    headroom: async () => 0n,
    issuanceLimit: async () => 0n,
    claimWindow: async () => ({ windowFrom: 0n, windowTo: 0n }),
    currentBlockTimestamp: async () => 0n,
  };
}

function fakeDeps(overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  return {
    chainReader: fakeChainReader(),
    deployment: fakeDeployment(),
    escrowAddress: "0x0000000000000000000000000000000000face",
    runGateHardeningChecks: async () => ({
      g1: { passed: true, reason: "ok" },
      g2: { passed: true, reason: "ok" },
      g3: { passed: true, reason: "ok" },
      g4: { passed: true, reason: "ok" },
      g5: { passed: true, reason: "ok" },
      passed: true,
    }),
    loadPrint: async () => ({ print_id: "2026-09-22" }) as unknown as Print,
    isReconciled: async () => false,
    ...overrides,
  };
}

function newRunner(deps: RunnerDeps = fakeDeps(), allowedTools?: readonly ToolName[]): Runner {
  return new Runner({
    agentId: "ORCHESTRATOR",
    windowId: "2026-W39",
    privateKeyHex: TEST_PRIVATE_KEY,
    rpcUrl: "http://127.0.0.1:1", // never actually dialed by this file's tests — see comment above
    deps,
    allowedTools,
    ceiling: new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    }),
  });
}

describe("Runner — key isolation (the WP-4 regression test)", () => {
  it("never leaks the private key into an assembled AgentContext", async () => {
    const runner = newRunner();

    await runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" });
    await runner.callTool(
      "submit_job",
      {
        taskClass: "code",
        originalGate: { taskClass: "code", source: "export async function gate(){}" },
        hardenedGate: { taskClass: "code", source: "export async function gate(){}" },
        referenceInstance: { taskClass: "code", files: {} },
        knownGoodSubmission: { files: {} },
        adversarialSubmissions: [],
      },
      { turn: 2, jobId: "job-1" },
    );

    const context = assembleContext(runner.agentId, "skill pack text", runner.toolCallRecords());
    const serialized = serializeContext(context);

    expect(serialized).not.toContain(TEST_PRIVATE_KEY);
    expect(serialized).not.toContain(TEST_PRIVATE_KEY.slice(2)); // without the 0x prefix too
    expect(serialized).not.toMatch(/0x[0-9a-fA-F]{64}/); // no 32-byte hex value of any kind
  });

  it("toolCallRecords() itself never contains the private key", async () => {
    const runner = newRunner();
    await runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" });

    const serialized = JSON.stringify(runner.toolCallRecords());
    expect(serialized).not.toContain(TEST_PRIVATE_KEY);
  });
});

describe("Runner — budget ceiling wiring", () => {
  it("halts the agent once its turn ceiling is hit, per §9.3", async () => {
    const deps = fakeDeps();
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 1, maxInferenceUsd: "1" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    });
    const runner = new Runner({
      agentId: "ORCHESTRATOR",
      windowId: "2026-W39",
      privateKeyHex: TEST_PRIVATE_KEY,
      rpcUrl: "http://127.0.0.1:1",
      deps,
      ceiling,
    });

    await runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" });

    await expect(
      runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 2, jobId: "job-1" }),
    ).rejects.toThrow(CeilingExceededError);

    // Halting ORCHESTRATOR must not affect another agent's own window state.
    expect(ceiling.isHalted("WORKER-CODE", "2026-W39")).toBe(false);
  });

  it("does not double-count a turn when a single turn makes multiple tool calls", async () => {
    const deps = fakeDeps();
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 1, maxInferenceUsd: "1" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    });
    const runner = new Runner({
      agentId: "ORCHESTRATOR",
      windowId: "2026-W39",
      privateKeyHex: TEST_PRIVATE_KEY,
      rpcUrl: "http://127.0.0.1:1",
      deps,
      ceiling,
    });

    // Two tool calls, same turn number — must consume only one unit of turn budget.
    await runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" });
    await runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" });

    expect(ceiling.remaining("ORCHESTRATOR", "2026-W39").turns).toBe(0);
  });

  it("checks meta.projectedInferenceUsd against the real dollar ceiling before the tool runs (pre-WP-7 fix, spec §12.2a)", async () => {
    const deps = fakeDeps();
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "0.10" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    });
    const runner = new Runner({
      agentId: "ORCHESTRATOR",
      windowId: "2026-W39",
      privateKeyHex: TEST_PRIVATE_KEY,
      rpcUrl: "http://127.0.0.1:1",
      deps,
      ceiling,
    });

    // A single projected turn costing more than the whole window's inference budget must refuse
    // the tool call outright — the real model call this would represent in WP-7 never happens.
    await expect(
      runner.callTool(
        "get_print",
        { printId: "2026-09-22" },
        { turn: 1, jobId: "job-1", projectedInferenceUsd: "0.50" },
      ),
    ).rejects.toThrow(CeilingExceededError);
  });

  it("omitting projectedInferenceUsd skips the dollar check entirely — no live model loop calls this yet", async () => {
    const deps = fakeDeps();
    const ceiling = new BudgetCeiling({
      "ISSUER-A": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "ISSUER-B": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      ORCHESTRATOR: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "0" },
      "WORKER-CODE": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      "WORKER-EXTRACT": { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
      HEDGER: { maxUsdcSpend: "1", maxInferenceTurns: 10, maxInferenceUsd: "1" },
    });
    const runner = new Runner({
      agentId: "ORCHESTRATOR",
      windowId: "2026-W39",
      privateKeyHex: TEST_PRIVATE_KEY,
      rpcUrl: "http://127.0.0.1:1",
      deps,
      ceiling,
    });

    // maxInferenceUsd is 0 — if the check ran unconditionally this would refuse. It doesn't,
    // because no projectedInferenceUsd was supplied.
    await expect(
      runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" }),
    ).resolves.toBeDefined();
  });
});

describe("Runner — tool-allowlist enforcement (WP-9 item 3, spec §12.3)", () => {
  it("denies and records a call outside allowedTools", async () => {
    const runner = newRunner(fakeDeps(), ["get_print"]);

    await expect(
      runner.callTool("submit_job", { taskClass: "code" }, { turn: 1, jobId: "job-1" }),
    ).rejects.toThrow(ToolNotAllowedError);

    expect(runner.deniedToolCalls()).toEqual([{ turn: 1, jobId: "job-1", toolName: "submit_job" }]);
    expect(runner.toolCallRecords()).toEqual([]);
  });

  it("allows a call that is in allowedTools", async () => {
    const runner = newRunner(fakeDeps(), ["get_print"]);

    await expect(
      runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" }),
    ).resolves.toBeDefined();
    expect(runner.deniedToolCalls()).toEqual([]);
  });

  it("allows every tool when allowedTools is omitted — unrestricted, matching every existing dry-loop scenario", async () => {
    const runner = newRunner();

    await expect(
      runner.callTool("get_print", { printId: "2026-09-22" }, { turn: 1, jobId: "job-1" }),
    ).resolves.toBeDefined();
    expect(runner.deniedToolCalls()).toEqual([]);
  });
});
