import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runForwardDatedClaim } from "./forward-dated-claim.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

// Own devnet: this scenario warps the chain clock forward by two 20-minute windows, which would
// close every other scenario's own windows underneath it.
describe("a claim dated for a later window — the property the three-window run rests on", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("consumes capacity now, cannot be presented until its window opens, and redeems once it does", async () => {
    const result = await runForwardDatedClaim(devnet, runners);

    // Capacity leaves the pool at the moment of minting, not when the window arrives — otherwise
    // "reserving future capacity" would reserve nothing anyone else could be shut out of.
    expect(result.headroomAfterMint).toBe(result.headroomBeforeMint - 500n);

    // And it is genuinely unusable until then: WorkClaim.presentForRedemption reverts
    // WindowNotOpenYet, surfaced through the tool exactly as any other revert is.
    expect(result.presentBeforeWindowOpenedError).toMatch(/revert|WindowNotOpenYet|0xc758223e/i);

    // Once its own window opens it behaves like any other claim, through to delivery.
    expect(result.presentedOnceWindowOpened).toBe(true);
    expect(result.headroomAfterDelivery).toBe(result.headroomBeforeMint);
  }, 120_000);
});
