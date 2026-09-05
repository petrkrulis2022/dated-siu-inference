import { beforeAll, describe, expect, it } from "vitest";
import { loadDeployment } from "@touchstone/sdk";
import { indexNewEvents } from "./index.js";
import { emptyCache, type EventCache } from "./cache.js";

/**
 * Against real Base Sepolia, the real deployed `TouchstoneEscrow`/`TouchstoneAttestation`, and the real
 * settlements this session's own demo agents and live tests have already produced — not a mock,
 * per the P13 lesson applied throughout this project. Read-only: only `getLogs`/`getBlock`/
 * `readContract` calls, matching the console's own hard constraint.
 *
 * Bounded to a fixed historical window, not "deployment block to the real current chain tip":
 * a full scan from the deployment block (base-sepolia.json's own smoke tests happened at
 * 45633221-45633556) genuinely took 150s+ once measured for real — 793,351 real blocks had
 * accumulated since deployment by 2026-09-05, needing ~800 sequential eth_getLogs calls at this
 * indexer's own chunk size, confirmed live (real per-call latency ~200ms, RPC itself healthy, no
 * rate-limit errors — this is pure accumulated range, not RPC degradation). That range only grows
 * every day Base Sepolia keeps producing blocks, so raising the hook timeout would only buy time
 * before the next failure, not fix anything. TOUCHSTONE_ESCROW_ADDRESS's real deploy-time smoke
 * tests are known, by construction, to have produced real Opened/Settled events inside
 * [45633221, 45633600] — confirmed live (7 Opened, 4 Settled) before writing this — so this
 * suite scans exactly that fixed, permanent window (indexNewEvents's toBlockOverride) instead:
 * genuinely bounded, one eth_getLogs chunk, and it will never grow no matter how much time passes.
 * The real production indexer (server/index.ts) never does a from-deployment full scan in normal
 * operation anyway — it always resumes incrementally from a persisted cache, exactly what the
 * second test below already exercises; this suite's "full scan" now demonstrates the same
 * historical-event-decoding correctness against a small, real, permanently-fixed slice of history
 * instead of the entire chain since deployment.
 */
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const describeLive = RPC_URL ? describe : describe.skip;

// Confirmed live (2026-09-05) via `cast logs` against exactly this range: 7 real Opened events,
// 4 real Settled events, from base-sepolia.json's own documented smoke tests.
const BOUNDED_SCAN_TO_BLOCK = 45_633_600n;

describeLive("indexNewEvents (live Base Sepolia)", () => {
  const deployment = loadDeployment("base-sepolia");
  const config = {
    rpcUrl: RPC_URL ?? "",
    escrowAddress: deployment.contracts.TouchstoneEscrow.address,
    escrowDeployBlock: BigInt(
      (deployment.contracts.TouchstoneEscrow as unknown as { blockNumber: number }).blockNumber,
    ),
    attestationAddress: deployment.contracts.TouchstoneAttestation.address,
    attestationDeployBlock: BigInt(
      (deployment.contracts.TouchstoneAttestation as unknown as { blockNumber: number })
        .blockNumber,
    ),
    toBlockOverride: BOUNDED_SCAN_TO_BLOCK,
  };

  let fullScan: EventCache;

  beforeAll(async () => {
    fullScan = await indexNewEvents(config, emptyCache());
  }, 30_000);

  it("scans from the deployment block and finds real Opened/Settled events with real fee/treasury values", () => {
    // This session has produced substantial real activity (P13 smoke tests, P14 demo agent
    // runs, live test suites) — asserting "at least" rather than an exact count keeps this test
    // robust as more real activity accrues over time, rather than pinning a moment-in-time
    // snapshot.
    expect(fullScan.events.opened.length).toBeGreaterThan(0);
    expect(fullScan.events.settled.length).toBeGreaterThan(0);

    const opened = fullScan.events.opened[0]!;
    expect(opened.quoteHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(opened.buyer).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(BigInt(opened.maxAmount)).toBeGreaterThan(0n);
    expect(new Date(opened.timestamp).getTime()).toBeGreaterThan(0);

    const settled = fullScan.events.settled[0]!;
    expect(settled.quoteHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
    expect(BigInt(settled.actualAmount)).toBeGreaterThanOrEqual(0n);

    // Real deployment fact — TOUCHSTONE_FEE_BPS=50 in this session's .env, confirmed against the live
    // contract's own immutable getter, not assumed.
    expect(fullScan.escrow.feeBps).toBe("50");
    expect(fullScan.escrow.treasury).toMatch(/^0x[0-9a-fA-F]{40}$/);

    expect(BigInt(fullScan.lastIndexedBlock.escrow)).toBeGreaterThanOrEqual(
      config.escrowDeployBlock,
    );
  });

  it("resuming from an up-to-date cache does near-zero work and finds no duplicate events", async () => {
    const resumed = await indexNewEvents(config, fullScan);

    // No new activity should have landed in the moment since the full scan above.
    expect(resumed.events.opened.length).toBe(fullScan.events.opened.length);
    expect(resumed.events.settled.length).toBe(fullScan.events.settled.length);
    expect(BigInt(resumed.lastIndexedBlock.escrow)).toBeGreaterThanOrEqual(
      BigInt(fullScan.lastIndexedBlock.escrow),
    );
  }, 30_000);
});
