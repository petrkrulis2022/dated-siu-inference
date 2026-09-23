import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ContextValidationError } from "../pack/validate.js";
import type { GateMarketReceipt } from "../receipt/types.js";
import { RunRecorder, recordedAgentIds, type RunManifest } from "./recorder.js";

const MANIFEST: RunManifest = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/code@0.0.0",
  agentConfigs: { ORCHESTRATOR: { reasoningModel: "gpt-5.1" } },
  seed: "test-seed-1",
};

function fakeReceipt(overrides: Partial<GateMarketReceipt> = {}): GateMarketReceipt {
  return {
    receipt_id: "receipt-1",
    parent_payment_id: null,
    quote_id: "quote-1",
    buyer: "ORCHESTRATOR",
    seller: "WORKER-CODE",
    executor: "WORKER-CODE",
    class: "code",
    siu_delivered: 1,
    gate_results: { G1: true, G2: true, G3: true, G4: true, G5: true, G6: true },
    settlement_asset: "USDC",
    settlement_amount: 1,
    usdc_equivalent_at_print: "0.0108",
    print_id: "2026-09-23",
    methodology_version: "SIU-2026a",
    claim_retired: true,
    usage: { input_tokens: 100, output_tokens: 50, retries: 0 },
    artefact_hashes: { gate_spec: "0xhash", adversarial_cases: [] },
    mechanism_caveat: "mechanism, not demand",
    ...overrides,
  };
}

describe("RunRecorder", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-run-recorder-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("creates the full spec §14.4 directory layout and writes manifest.yaml on construction", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);

    expect(existsSync(join(recorder.runDir, "contexts"))).toBe(true);
    expect(existsSync(join(recorder.runDir, "receipts"))).toBe(true);
    expect(existsSync(join(recorder.runDir, "messages"))).toBe(true);
    expect(existsSync(join(recorder.runDir, "manifest.yaml"))).toBe(true);

    const manifest = parse(readFileSync(join(recorder.runDir, "manifest.yaml"), "utf-8"));
    expect(manifest).toEqual(MANIFEST);
  });

  it("messages/ is created empty — the free-text channel (spec §13.3) is out of scope here", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    expect(readdirSync(join(recorder.runDir, "messages"))).toEqual([]);
  });

  it("recordContext persists the exact AgentContext under contexts/<agentId>/<turn>.json", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    const context = { agentId: "ORCHESTRATOR" as const, skillPackText: "skill text", toolCalls: [] };

    recorder.recordContext("ORCHESTRATOR", 1, context);

    const written = JSON.parse(readFileSync(join(recorder.runDir, "contexts", "ORCHESTRATOR", "1.json"), "utf-8"));
    expect(written).toEqual(context);
  });

  it("recordReceipt persists under receipts/<receipt_id>.json", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    const receipt = fakeReceipt();

    recorder.recordReceipt(receipt);

    const written = JSON.parse(readFileSync(join(recorder.runDir, "receipts", "receipt-1.json"), "utf-8"));
    expect(written).toEqual(receipt);
  });

  it("recordValidatorVerdict records a pass — spec §12.4's 'including passes'", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);

    recorder.recordValidatorVerdict("ORCHESTRATOR", 1, null);

    const verdicts = JSON.parse(readFileSync(join(recorder.runDir, "validator.json"), "utf-8"));
    expect(verdicts).toEqual([{ agentId: "ORCHESTRATOR", turn: 1, passed: true }]);
  });

  it("recordValidatorVerdict records a failure with the real error's kind and matched text", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    const error = new ContextValidationError("asset-preference", "use USDC whenever possible");

    recorder.recordValidatorVerdict("ISSUER-A", 3, error);

    const verdicts = JSON.parse(readFileSync(join(recorder.runDir, "validator.json"), "utf-8"));
    expect(verdicts).toEqual([
      {
        agentId: "ISSUER-A",
        turn: 3,
        passed: false,
        failure: { kind: "asset-preference", matched: "use USDC whenever possible" },
      },
    ]);
  });

  it("accumulates every verdict across the run, not just the most recent", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    recorder.recordValidatorVerdict("ORCHESTRATOR", 1, null);
    recorder.recordValidatorVerdict("ORCHESTRATOR", 2, null);

    const verdicts = JSON.parse(readFileSync(join(recorder.runDir, "validator.json"), "utf-8"));
    expect(verdicts).toHaveLength(2);
  });

  it("finalizeMetrics writes metrics.json", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    recorder.finalizeMetrics({ turnsUsed: 2 });

    const metrics = JSON.parse(readFileSync(join(recorder.runDir, "metrics.json"), "utf-8"));
    expect(metrics).toEqual({ turnsUsed: 2 });
  });

  it("wires .friction to the same run directory, under a friction/ subfolder (spec §14.4 layout)", async () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    await recorder.friction.append({
      agent: "ORCHESTRATOR",
      turn: 1,
      job_id: "job-1",
      attempted: "x",
      outcome: "y",
      could_not_express: null,
      forced_conversion: false,
      conversion_reason: null,
      missing_information: null,
      decision_confidence: "high",
      time_to_expiry_seconds: null,
    });

    expect(existsSync(join(recorder.runDir, "friction", "friction-log.jsonl"))).toBe(true);
    expect(existsSync(join(recorder.runDir, "friction", "caveat.json"))).toBe(true);
  });
});

describe("recordedAgentIds", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-run-recorder-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("returns every agentId with a contexts/ subdirectory", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    recorder.recordContext("ORCHESTRATOR", 1, { agentId: "ORCHESTRATOR", skillPackText: "x", toolCalls: [] });
    recorder.recordContext("WORKER-CODE", 1, { agentId: "WORKER-CODE", skillPackText: "y", toolCalls: [] });

    expect(recordedAgentIds(recorder.runDir).sort()).toEqual(["ORCHESTRATOR", "WORKER-CODE"]);
  });

  it("returns an empty array for a run directory with no contexts/ at all", () => {
    expect(recordedAgentIds(path.join(runsRoot, "never-created"))).toEqual([]);
  });
});
