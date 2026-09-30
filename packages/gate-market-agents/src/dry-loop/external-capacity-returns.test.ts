import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runExternalCapacityReturns } from "./external-capacity-returns.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

// Own devnet: this scenario warps the clock a full run forward, which would break any scenario
// sharing the instance.
describe("external-buyer capacity returns at run end — the depletion ratchet", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("returns exactly what it consumed, so consecutive runs start from identical headroom", async () => {
    const r = await runExternalCapacityReturns(devnet, runners);

    expect(r.headroomBefore - r.headroomDuringRun).toBe(r.quantity);
    // Not early: the scarcity a run is built on survives the fix.
    expect(r.settleBeforeRunEndError).toMatch(/WindowNotClosedYet|window/i);
    // And exactly: this is the property "five comparable runs" depends on.
    expect(r.headroomAfterRunEnd).toBe(r.headroomBefore);
  }, 120_000);
});
