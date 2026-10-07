/**
 * Direct settlement through the real loop and a real chain (a local devnet), instrument v4 (D30, D32): a quote paid in
 * USDC is a transfer to its seller, a quote paid from a held claim and USDC is two transfers, and neither opens an escrow.
 *
 * The escrow address handed to the loop is a dead address with no contract behind it. A payment that tried to open an
 * escrow would fail against it, so a payment that succeeds did not.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Adapter, AdapterResult } from "@touchstone/harness";
import type { Print } from "@touchstone/sdk";
import type { RunnerDeps } from "../deps.js";
import type { RunManifest } from "../run-recorder/recorder.js";
import { BudgetCeiling } from "../budget/ceiling.js";
import { ExperimentBudget } from "../budget/experiment-budget.js";
import { CANONICAL_ASSET_DESCRIPTION } from "../skills/asset-description.js";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { ViemChainReader } from "../chain/reader.js";
import { AGENT_IDS, erc8004IdFor, type AgentId } from "../identity/resolve.js";
import { printDateToUnixDay, SERIES_COMMODITY } from "../chain/rate-attestation.js";
import { toolErrorsOf } from "../cli/tool-errors.js";
import { QuoteBoard } from "./quote-board.js";
import { runFullRunWindow, type FullRunWindowResult, type JobEnvelope, type RosterAgentConfig } from "./full-run.js";

const PRICES = { priceInUsdPer1M: "2", priceOutUsdPer1M: "12" };
const JOB: JobEnvelope = {
  jobId: "direct-settlement-job",
  taskClass: "extract",
  originalGate: { taskClass: "extract", source: "" },
  referenceInstance: { taskClass: "extract", files: {} },
  knownGoodSubmission: { files: {} },
  adversarialSubmissions: [],
  heldOutInstances: [{ referenceInstance: { taskClass: "extract", files: {} }, knownGoodSubmission: { files: {} }, adversarialSubmissions: [] }],
} as unknown as JobEnvelope;
const MANIFEST: RunManifest = { benchVersion: "0.0.0", packVersion: "direct-settlement@0.0.0", agentConfigs: {}, seed: "direct-settlement" };
const DEAD_ESCROW = "0x000000000000000000000000000000000000dEaD";

const respond = (text: string): AdapterResult => ({
  text,
  usage: { input: 100, output: 50, cached_input: 0, reasoning: 0 },
  latency_ms: 1,
  raw: {},
  deviations: [],
});

describe("direct settlement, end to end (instrument v4)", () => {
  let devnet: DevnetHandle;
  let runsRoot: string;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 180_000);
  afterAll(async () => {
    await devnet.stop();
  });
  beforeEach(async () => {
    runsRoot = await mkdtemp(path.join(tmpdir(), "direct-settlement-"));
  });
  afterEach(async () => {
    await rm(runsRoot, { recursive: true, force: true });
  });

  const cfg = (agentId: AgentId, adapter: Adapter, availableTools: RosterAgentConfig["availableTools"]): RosterAgentConfig => ({
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

  /** ORCHESTRATOR hands WORKER-CODE 1,500 mSIU; WORKER-CODE asks WORKER-EXTRACT for a 10,000-minor-unit quote and pays it with `pay`. */
  async function run(payment: (requestId: string, tokenId: string) => { tool: string; args: Record<string, unknown> }): Promise<{
    result: FullRunWindowResult;
    sellerPrompts: string[];
    chain: ViemChainReader;
    tokenId: string;
  }> {
    let tokenId: string | undefined;
    let orchCall = 0;
    const orchAdapter: Adapter = async (_m, prompt) => {
      orchCall++;
      if (orchCall === 1) return respond(JSON.stringify({ tool: "mint_claim", args: { quantity: "1500" } }));
      if (orchCall === 2) {
        tokenId = prompt.match(/"tokenId":"(\d+)"/)?.[1];
        return respond(JSON.stringify({ tool: "transfer_claim", args: { agentId: "WORKER-CODE", tokenId, quantity: "1500" } }));
      }
      return respond(JSON.stringify({ done: true, summary: "funded the buyer" }));
    };
    const sellerId = erc8004IdFor(devnet.agents["WORKER-EXTRACT"].address);
    let buyerCall = 0;
    let paid = false;
    const buyerAdapter: Adapter = async (_m, prompt) => {
      buyerCall++;
      if (buyerCall === 1) {
        return respond(
          JSON.stringify({
            tool: "request_quote",
            args: {
              siu: "1", model: "test", rateUsdPerSiu: "0.0100", indexVersion: "SIU-2026a", printId: "direct-test-print",
              printHash: `0x${"11".repeat(32)}`, sellerId, chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed",
            },
          }),
        );
      }
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      if (requestId !== undefined && tokenId !== undefined && !paid) {
        paid = true;
        return respond(JSON.stringify(payment(requestId, tokenId)));
      }
      return paid ? respond(JSON.stringify({ done: true, summary: "paid" })) : respond(JSON.stringify({ wait: true }));
    };
    const sellerPrompts: string[] = [];
    const answered = new Set<string>();
    const sellerAdapter: Adapter = async (_m, prompt) => {
      sellerPrompts.push(prompt);
      const requestId = prompt.match(/(qr-\d+)/)?.[1];
      if (requestId === undefined || answered.has(requestId)) return respond(JSON.stringify({ wait: true }));
      answered.add(requestId);
      return respond(JSON.stringify({ tool: "issue_quote", args: { requestId } }));
    };
    const ceiling = new BudgetCeiling(
      Object.fromEntries(AGENT_IDS.map((id) => [id, { maxUsdcSpend: "1000000", maxInferenceTurns: 100, maxInferenceUsd: "1000000" }])) as Record<
        AgentId,
        { maxUsdcSpend: string; maxInferenceTurns: number; maxInferenceUsd: string }
      >,
    );
    const chain = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
    const result = await runFullRunWindow({
      windowId: "w-direct",
      roster: [
        cfg("ORCHESTRATOR", orchAdapter, ["mint_claim", "transfer_claim"]),
        cfg("WORKER-CODE", buyerAdapter, ["get_balances", "request_quote", "pay", "settle_split_held"]),
        cfg("WORKER-EXTRACT", sellerAdapter, ["issue_quote", "get_print"]),
      ],
      job: JOB,
      maxTurnsPerAgent: 6,
      budget: new ExperimentBudget({ ceiling, runCapUsd: "1000000", experimentCapUsd: "1000000", ledgerPath: path.join(runsRoot, "ledger.json") }),
      deps: {
        chainReader: chain,
        deployment: devnet.deployment,
        escrowAddress: DEAD_ESCROW,
        runGateHardeningChecks: async () => {
          throw new Error("no gate here");
        },
        loadPrint: async () => ({ print_id: "direct-test-print" }) as unknown as Print,
        isReconciled: async () => false,
        directSettlement: true,
      } as RunnerDeps,
      runsRoot,
      runId: "run-direct",
      manifest: MANIFEST,
      board: new QuoteBoard({ reservationStep: false, escrow: false }),
      mintContext: {
        publisherPrivateKeyHex: devnet.publisherPrivateKeyHex,
        printId: "direct-test-print",
        series: SERIES_COMMODITY,
        printDate: printDateToUnixDay("2026-09-25"),
        nanoUsdPerSiu: 10_000_000n,
        validitySeconds: 3600n,
      },
    });
    return { result, sellerPrompts, chain, tokenId: tokenId! };
  }

  const sellerAddr = (): `0x${string}` => devnet.agents["WORKER-EXTRACT"].address as `0x${string}`;
  const buyerAddr = (): `0x${string}` => devnet.agents["WORKER-CODE"].address as `0x${string}`;

  it("pays a quote in USDC by a transfer to its seller, with no escrow opened and nothing to release", async () => {
    const chain = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
    const sellerBefore = await chain.usdcBalance(sellerAddr());
    const buyerBefore = await chain.usdcBalance(buyerAddr());
    const { result, sellerPrompts } = await run((requestId) => ({
      tool: "pay",
      args: { requestId, settler: "0x0000000000000000000000000000000000000000" },
    }));
    // 0.0100 USD is 10,000 USDC minor units, and the dead-address escrow could not have been opened.
    expect((await chain.usdcBalance(sellerAddr())) - sellerBefore).toBe(10_000n);
    expect(buyerBefore - (await chain.usdcBalance(buyerAddr()))).toBe(10_000n);
    const moment = result.paymentMoments.find((m) => m.agentId === "WORKER-CODE");
    expect(moment).toMatchObject({ tool: "pay", asset: "usdc" });
    expect(result.usdcSettlements).toEqual([]); // nothing was released, so nothing was settled
    expect(sellerPrompts.some((p) => p.includes("real USDC is in escrow"))).toBe(false);
    expect(toolErrorsOf(result.turnLogsByAgent)).toEqual([]);
  }, 120_000);

  it("pays a quote partly from a held claim and partly in USDC, both at once, and records the claim part as a held-claim transfer", async () => {
    const chain = new ViemChainReader(devnet.deployment, devnet.rpcUrl);
    const sellerUsdcBefore = await chain.usdcBalance(sellerAddr());
    const buyerUsdcBefore = await chain.usdcBalance(buyerAddr());
    const { result, tokenId } = await run((requestId, token) => ({
      tool: "settle_split_held",
      args: { requestId, tokenId: token, claimQuantityMilliSiu: "500" },
    }));
    // 500 mSIU at 10,000,000 nano-USD per SIU is worth 5,000 minor units; the other 5,000 of the 10,000 is dollars.
    expect((await chain.usdcBalance(sellerAddr())) - sellerUsdcBefore).toBe(5_000n);
    expect(buyerUsdcBefore - (await chain.usdcBalance(buyerAddr()))).toBe(5_000n);
    // Only this test ever pays a claim to the seller, so its balance is exactly the claim part. The buyer's balance is not asserted
    // on the chain: both tests mint into one devnet, and the claim token is the same when their windows coincide, so what the
    // buyer held before this run is not this test's to know. The loop's own ledger, which is per run, covers it below.
    expect(await chain.claimBalance(BigInt(tokenId), sellerAddr())).toBe(500n);

    expect(result.paymentMoments.find((m) => m.agentId === "WORKER-CODE")).toMatchObject({ tool: "settle_split_held", asset: "split", heldReceivedMilliSiu: "1500" });
    const claimPart = result.capacityEvents.find((e) => e.kind === "transfer_claim" && e.agentId === "WORKER-CODE");
    expect(claimPart).toMatchObject({ quantityMilliSiu: "500", claimShare: "0.5000" });
    expect(claimPart?.settlesRequestId).toMatch(/^qr-\d+$/);
    // The loop's own ledger agrees with the chain: the seller was given 500 mSIU, and the buyer passed on received fSIU.
    expect(result.claimFlows["WORKER-EXTRACT"]).toMatchObject({ receivedKeyedMilliSiu: "500" });
    expect(result.claimFlows["WORKER-CODE"]).toMatchObject({ transferredOutKeyedMilliSiu: "500" });
    expect(toolErrorsOf(result.turnLogsByAgent)).toEqual([]);
  }, 120_000);
});
