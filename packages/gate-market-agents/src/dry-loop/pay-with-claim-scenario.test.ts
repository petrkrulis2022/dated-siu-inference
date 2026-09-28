import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupDevnet, type DevnetHandle } from "../devnet/deploy.js";
import { buildRunners } from "./context.js";
import { runPayWithClaimScenario } from "./pay-with-claim-scenario.js";
import type { Runner } from "../runner.js";
import type { AgentId } from "../identity/resolve.js";

describe("pay_with_claim — mint and transfer, end to end on real bytecode", () => {
  let devnet: DevnetHandle;
  let runners: Record<AgentId, Runner>;

  beforeAll(async () => {
    devnet = await setupDevnet();
    runners = buildRunners(devnet);
  }, 180_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("ends with the recipient holding the claim and the caller holding none of it", async () => {
    const result = await runPayWithClaimScenario(devnet, runners);
    expect(result.recipientBalanceAfter).toBe(500n);
    expect(result.callerBalanceAfter).toBe(0n);
  }, 120_000);
});
