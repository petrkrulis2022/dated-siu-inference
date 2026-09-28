import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { ONE_POOL_EXPECTED_MILLI_SIU, runOnePool } from "./one-pool.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

// Own fresh devnet, same reasoning as the headroom-exhaustion scenario's: this one moves
// ISSUER-A's `code` headroom and settles a real escrow, which other scenarios read.
describe("one pool — a dollar-paid job consumes the same bonded capacity a claim does", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("reserves against the same headroom a mint would, and returns it on settlement", async () => {
    const result = await runOnePool(devnet, runners);

    expect(result.reservedQuantity).toBe(ONE_POOL_EXPECTED_MILLI_SIU);
    expect(result.routedIssuer.toLowerCase()).toBe(
      devnet.agents["ISSUER-A"].address.toLowerCase(),
    );
    // The whole point: paying in dollars is not free of the constraint minting faces.
    expect(result.headroomAfterReserve).toBe(result.headroomBefore - ONE_POOL_EXPECTED_MILLI_SIU);
    // And the capacity comes back once the work is paid for — exactly, never more.
    expect(result.headroomAfterSettle).toBe(result.headroomBefore);
  }, 120_000);
});
