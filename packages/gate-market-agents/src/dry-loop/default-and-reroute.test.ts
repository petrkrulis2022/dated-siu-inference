import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runDefaultAndReroute } from "./default-and-reroute.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("WP-5 §4.5 — default", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("a presented-but-never-served claim defaults: bond pays the holder, headroom restored, and the system recovers", async () => {
    const result = await runDefaultAndReroute(devnet, runners);

    expect(result.holderBalanceAfterSettle).toBe(0n); // burned on default, same as a pass
    expect(result.headroomAfterSettle).toBe(result.headroomBeforeMint); // fully restored
    expect(result.holderUsdcDelta).toBe(result.expectedDefaultPayoutUsd); // bond paid exactly the print value
    expect(result.secondMintSucceeded).toBe(true); // the system isn't stuck afterward
  }, 90_000);
});
