import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GateMarketReceipt } from "../receipt/types.js";
import { RunRecorder, type RunManifest } from "./recorder.js";
import { computeBasicMetrics } from "./replay.js";

const MANIFEST: RunManifest = {
  benchVersion: "0.0.0",
  packVersion: "gate-hardening/code@0.0.0",
  agentConfigs: {},
  seed: "replay-test-seed",
};

function fakeReceipt(receiptId: string, usdcEquivalent: string, claimRetired: boolean): GateMarketReceipt {
  return {
    receipt_id: receiptId,
    parent_payment_id: null,
    quote_id: `quote-${receiptId}`,
    buyer: "ORCHESTRATOR",
    seller: "WORKER-CODE",
    executor: "WORKER-CODE",
    class: "code",
    siu_delivered: 1,
    gate_results: { G1: true, G2: true, G3: true, G4: true, G5: claimRetired },
    settlement_asset: "USDC",
    settlement_amount: 1,
    usdc_equivalent_at_print: usdcEquivalent,
    print_id: "2026-09-23",
    methodology_version: "SIU-2026a",
    claim_retired: claimRetired,
    usage: { input_tokens: 100, output_tokens: 50, retries: 0 },
    artefact_hashes: { gate_spec: "0xhash", adversarial_cases: [] },
    mechanism_caveat: "mechanism, not demand",
  };
}

describe("computeBasicMetrics — spec §15 WP-9's own test: a run directory replays into identical metrics", () => {
  let runsRoot: string;

  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "gate-market-replay-"));
  });

  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  it("recomputes, from disk alone, the same metrics that were live-computed and written at record time", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);

    // Real turns, two agents.
    recorder.recordContext("ORCHESTRATOR", 1, { agentId: "ORCHESTRATOR", skillPackText: "x", toolCalls: [] });
    recorder.recordContext("ORCHESTRATOR", 2, { agentId: "ORCHESTRATOR", skillPackText: "x", toolCalls: [] });
    recorder.recordContext("WORKER-CODE", 1, { agentId: "WORKER-CODE", skillPackText: "y", toolCalls: [] });

    // Real receipts — one retired, one not, real decimal amounts (never floats).
    recorder.recordReceipt(fakeReceipt("receipt-1", "0.0108", true));
    recorder.recordReceipt(fakeReceipt("receipt-2", "0.0054", false));

    // What was computed "live" at the end of the run and written via finalizeMetrics.
    const liveMetrics = computeBasicMetrics(recorder.runDir);
    recorder.finalizeMetrics(liveMetrics);

    // "Replay": recompute purely from what's on disk, with no access to the recorder instance
    // or any in-memory state above — a fresh call against only the persisted files.
    const replayedMetrics = computeBasicMetrics(recorder.runDir);

    expect(replayedMetrics).toEqual(liveMetrics);
    expect(replayedMetrics).toEqual({
      contextsRecorded: { ORCHESTRATOR: 2, "WORKER-CODE": 1 },
      receiptsRecorded: 2,
      claimsRetired: 1,
      totalUsdcEquivalentAtPrint: "0.0162",
    });
  });

  it("returns zeroed metrics for a run directory with no receipts or contexts yet", () => {
    const recorder = new RunRecorder(runsRoot, "run-1", MANIFEST);
    const metrics = computeBasicMetrics(recorder.runDir);
    expect(metrics).toEqual({
      contextsRecorded: {},
      receiptsRecorded: 0,
      claimsRetired: 0,
      totalUsdcEquivalentAtPrint: "0",
    });
  });
});
