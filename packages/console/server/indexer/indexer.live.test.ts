import { beforeAll, describe, expect, it } from "vitest";
import { loadDeployment } from "@datum/sdk";
import { indexNewEvents } from "./index.js";
import { emptyCache, type EventCache } from "./cache.js";

/**
 * Against real Base Sepolia, the real deployed `DatumEscrow`/`DatumAttestation`, and the real
 * settlements this session's own demo agents and live tests have already produced — not a mock,
 * per the P13 lesson applied throughout this project. Read-only: only `getLogs`/`getBlock`/
 * `readContract` calls, matching the console's own hard constraint.
 */
const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
const describeLive = RPC_URL ? describe : describe.skip;

describeLive("indexNewEvents (live Base Sepolia)", () => {
  const deployment = loadDeployment("base-sepolia");
  const config = {
    rpcUrl: RPC_URL ?? "",
    escrowAddress: deployment.contracts.DatumEscrow.address,
    escrowDeployBlock: BigInt(
      (deployment.contracts.DatumEscrow as unknown as { blockNumber: number }).blockNumber,
    ),
    attestationAddress: deployment.contracts.DatumAttestation.address,
    attestationDeployBlock: BigInt(
      (deployment.contracts.DatumAttestation as unknown as { blockNumber: number }).blockNumber,
    ),
  };

  let fullScan: EventCache;

  beforeAll(async () => {
    fullScan = await indexNewEvents(config, emptyCache());
  }, 90_000);

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

    // Real deployment fact — DATUM_FEE_BPS=50 in this session's .env, confirmed against the live
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
