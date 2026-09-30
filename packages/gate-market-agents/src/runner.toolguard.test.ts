import { describe, expect, it } from "vitest";
import { Runner, ToolRefusedError, type RunnerOptions } from "./runner.js";
import { BudgetCeiling } from "./budget/ceiling.js";
import { AGENT_IDS, type AgentId } from "./identity/resolve.js";
import type { RunnerDeps } from "./deps.js";
import type { Print } from "@touchstone/sdk";

function generousCeiling(): BudgetCeiling {
  return new BudgetCeiling(
    Object.fromEntries(
      AGENT_IDS.map((id) => [
        id,
        { maxUsdcSpend: "1000", maxInferenceTurns: 100, maxInferenceUsd: "1000" },
      ]),
    ) as Record<
      AgentId,
      { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }
    >,
  );
}

function deps(): RunnerDeps {
  return {
    chainReader: {
      usdcBalance: async () => 0n,
      claimBalance: async () => 0n,
      headroom: async () => 0n,
      issuanceLimit: async () => 0n,
      claimWindow: async () => ({ windowFrom: 0n, windowTo: 0n }),
      currentBlockTimestamp: async () => 0n,
      escrowState: async () => {
        throw new Error("unused");
      },
      reservation: async () => {
        throw new Error("unused");
      },
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
    runGateHardeningChecks: async () => {
      throw new Error("must not be reached");
    },
    loadPrint: async () => ({ print_id: "p" }) as unknown as Print,
    isReconciled: async () => false,
  };
}

const KEY = "0xa715563de5d5c011627720140757574d96bcfc02bdf2e0ee1f68d64e171fe89a";

function runnerWithGuard(guard?: (t: string) => string | null): Runner {
  return new Runner({
    agentId: "WORKER-CODE",
    windowId: "w",
    privateKeyHex: KEY,
    rpcUrl: "http://127.0.0.1:1",
    deps: deps(),
    ceiling: generousCeiling(),
    allowedTools: ["submit_job", "get_print"],
    toolGuard: guard as RunnerOptions["toolGuard"],
  });
}

describe("Runner toolGuard — enforcing at the boundary, not in a brief", () => {
  it("refuses a permitted tool when live state says this call is illegitimate", async () => {
    // The rule WORKER-CODE's brief stated in capitals and broke three times out of three on
    // 2026-09-28, after already breaking it on 2026-09-26: a claim holder does not author the
    // work its own issuer owes.
    const runner = runnerWithGuard((t) =>
      t === "submit_job" ? "you hold a claim for this job" : null,
    );
    await expect(
      runner.callTool("submit_job", { source: "x" }, { turn: 1, jobId: "j" }),
    ).rejects.toThrow(ToolRefusedError);
  });

  it("records the refusal rather than silently dropping it", async () => {
    const runner = runnerWithGuard((t) =>
      t === "submit_job" ? "you hold a claim for this job" : null,
    );
    await runner.callTool("submit_job", { source: "x" }, { turn: 1, jobId: "j" }).catch(() => {});
    expect(runner.deniedToolCalls()).toEqual([{ turn: 1, jobId: "j", toolName: "submit_job" }]);
  });

  it("carries the reason to the model, so it can act on it instead of just seeing a failure", async () => {
    const runner = runnerWithGuard(() => "the routed issuer ISSUER-A owes this delivery, not you");
    await expect(
      runner.callTool("submit_job", { source: "x" }, { turn: 1, jobId: "j" }),
    ).rejects.toThrow(/ISSUER-A owes this delivery/);
  });

  it("refuses before the handler runs — a refused call must never do the work anyway", async () => {
    // deps.runGateHardeningChecks throws if reached; the refusal must come first.
    const runner = runnerWithGuard(() => "no");
    await expect(
      runner.callTool("submit_job", { source: "x" }, { turn: 1, jobId: "j" }),
    ).rejects.toThrow(ToolRefusedError);
  });

  it("permits everything when the guard returns null, and when no guard is set at all", async () => {
    const guarded = runnerWithGuard(() => null);
    await expect(
      guarded.callTool("get_print", { printId: "p" }, { turn: 1, jobId: "j" }),
    ).resolves.toBeDefined();

    const unguarded = runnerWithGuard(undefined);
    await expect(
      unguarded.callTool("get_print", { printId: "p" }, { turn: 1, jobId: "j" }),
    ).resolves.toBeDefined();
  });
});
