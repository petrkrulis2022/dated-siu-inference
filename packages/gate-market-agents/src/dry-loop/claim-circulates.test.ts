import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runClaimCirculates } from "./claim-circulates.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("a claim circulates — passed on, then redeemed by the second holder", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("moves between holders without being redeemed, and the second holder can redeem it", async () => {
    const r = await runClaimCirculates(devnet, runners);
    const q = BigInt(r.quantity);

    expect(r.firstHolderAfterPayment).toBe(q);
    // The hop that has never happened in a real run.
    expect(r.firstHolderAfterPassingOn).toBe(0n);
    expect(r.secondHolderAfterPassingOn).toBe(q);
    // And the second holder — not the one that was paid — gets the work.
    expect(r.secondHolderAfterRedemption).toBe(0n);
    // Delivery retires the claim and returns the capacity, exactly as a one-hop redemption does:
    // circulating a claim must not cost the issuer anything extra.
    expect(r.headroomAfterDelivery).toBe(r.headroomBefore + q);
  }, 120_000);
});
