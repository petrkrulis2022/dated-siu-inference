import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { loadSkill } from "../skills/registry.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { runSmokePass } from "./smoke-pass.js";

const MANIFEST: RunManifest = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/code@0.0.0",
  agentConfigs: {},
  seed: "smoke-pass-test-seed",
};

const PRICES = { priceInUsdPer1M: "1.25", priceOutUsdPer1M: "10" }; // gpt-5.1's real registry price

function fakeDeps(): RunnerDeps {
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
  };
}

function scriptedAdapter(responses: string[]): Adapter {
  let call = 0;
  return async (): Promise<AdapterResult> => {
    const text = responses[Math.min(call, responses.length - 1)];
    call++;
    return {
      text,
      usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
      latency_ms: 1,
      raw: {},
      deviations: [],
    };
  };
}

const SUBMIT_JOB_ARGS = JSON.stringify({
  taskClass: "code",
  originalGate: { taskClass: "code", source: "x" },
  hardenedGate: { taskClass: "code", source: "y" },
  referenceInstance: { taskClass: "code", files: {} },
  knownGoodSubmission: { files: {} },
  adversarialSubmissions: [],
});

function baseOptions(runsRoot: string) {
  return {
    modelString: "gpt-5.1",
    prices: PRICES,
    maxOutputTokens: 2000,
    maxTurns: 20,
    maxInferenceUsd: "0.50",
    // A real skill file + the real canonical asset description — validateAgentContext (WP-6)
    // correctly rejects anything less, exactly as it's designed to.
    skillPackText: `${loadSkill("subcontract-and-settle").promptTemplate}\n\n${CANONICAL_ASSET_DESCRIPTION}`,
    availableTools: ["submit_job"] as const,
    deps: fakeDeps(),
    jobId: "smoke-test-job",
    runsRoot,
    runId: "smoke-pass-test-run",
    manifest: MANIFEST,
  };
}

describe("runSmokePass", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-smoke-pass-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("completes in the real turn count when the model calls submit_job then signals done", async () => {
    const result = await runSmokePass({
      ...baseOptions(runsRoot),
      adapter: scriptedAdapter([
        `{"tool": "submit_job", "args": ${SUBMIT_JOB_ARGS}}`,
        '{"done": true, "summary": "job passed G1-G5"}',
      ]),
    });

    expect(result.done).toBe(true);
    expect(result.turnsUsed).toBe(2);
    expect(result.summary).toBe("job passed G1-G5");
    expect(Number(result.totalRealizedUsd)).toBeGreaterThan(0);
    expect(result.turnLogs).toHaveLength(2);
  });

  it("halts with parse_error on an unparseable response rather than retrying or guessing", async () => {
    const result = await runSmokePass({
      ...baseOptions(runsRoot),
      adapter: scriptedAdapter(["I'm not sure what to do."]),
    });

    expect(result.done).toBe(false);
    expect(result.haltedReason).toBe("parse_error");
    expect(result.turnsUsed).toBe(1);
  });

  it("stops at exactly maxTurns if the model never signals done", async () => {
    const result = await runSmokePass({
      ...baseOptions(runsRoot),
      maxTurns: 3,
      adapter: scriptedAdapter([`{"tool": "submit_job", "args": ${SUBMIT_JOB_ARGS}}`]),
    });

    expect(result.done).toBe(false);
    expect(result.haltedReason).toBe("max_turns");
    expect(result.turnsUsed).toBe(3);
  });

  it("halts on the real dollar ceiling before it would be exceeded — the property that matters", async () => {
    // gpt-5.1 at $1.25 in / $10 out per 1M: a 2000-max-output-token turn projects to roughly
    // (prompt_tokens/1e6)*1.25 + (2000/1e6)*10 ≈ a few cents per turn — a tiny ceiling forces a
    // halt within a handful of turns rather than the full 20, proving the ceiling is real, not
    // just present in config.
    const result = await runSmokePass({
      ...baseOptions(runsRoot),
      maxInferenceUsd: "0.01",
      adapter: scriptedAdapter([`{"tool": "submit_job", "args": ${SUBMIT_JOB_ARGS}}`]),
    });

    expect(result.done).toBe(false);
    expect(result.haltedReason).toBe("ceiling");
    expect(result.turnsUsed).toBeLessThan(20);
    expect(Number(result.totalRealizedUsd)).toBeLessThan(0.05); // halted early, not after the fact
  });

  it("never exceeds maxTurns even against a mock adapter that never stops", async () => {
    // The "loops forever" case this ceiling exists for — a generous dollar cap so the turn cap
    // is what actually fires, proving both bounds independently rather than only ever hitting
    // whichever is checked first.
    const result = await runSmokePass({
      ...baseOptions(runsRoot),
      maxTurns: 5,
      maxInferenceUsd: "1000",
      adapter: scriptedAdapter([`{"tool": "submit_job", "args": ${SUBMIT_JOB_ARGS}}`]),
    });

    expect(result.turnsUsed).toBe(5);
    expect(result.haltedReason).toBe("max_turns");
  });
});
