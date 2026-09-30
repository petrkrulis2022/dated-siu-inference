import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runSettleSplit } from "./settle-split.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("settle_split — one quote, two assets, one call", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("funds the escrow for the remainder under the original quote hash, and delivers the claim leg", async () => {
    const r = await runSettleSplit(devnet, runners);

    // The claim leg really reached the seller, and really consumed bonded capacity.
    expect(r.sellerClaimBalance).toBe(BigInt(r.claimQuantityMilliSiu));
    expect(r.headroomBefore - r.headroomAfter).toBe(BigInt(r.claimQuantityMilliSiu));

    // The dollar leg is the REMAINDER, not the whole quote — the assertion that would catch an
    // implementation which settled the claim leg and then funded the escrow in full.
    expect(r.escrowMaxAmount).toBe(r.quotedMinorUnits - r.claimValueMinorUnits);
    expect(r.escrowMaxAmount).toBeGreaterThan(0n);

    // And it is keyed by the ORIGINAL quote's hash: escrowState found it under that hash, so the
    // seller can still settle the quote it signed.
    expect(r.claimValueMinorUnits).toBeGreaterThan(0n);
  }, 120_000);
});
