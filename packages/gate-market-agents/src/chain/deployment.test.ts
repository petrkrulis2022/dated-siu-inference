import { describe, expect, it } from "vitest";
import { loadGateMarketDeployment } from "./deployment.js";

describe("loadGateMarketDeployment", () => {
  it("throws an actionable error for a path that doesn't exist", () => {
    // Not the default path — see the test below for that. A caller pointed at some other,
    // not-yet-deployed chain's file should still fail loudly rather than get placeholder
    // addresses, matching StubSettlementReader's precedent.
    expect(() => loadGateMarketDeployment("data/deployments/not-a-real-file.json")).toThrow(
      /have not been deployed/,
    );
  });

  it("loads the real Base Sepolia deployment — redeployed 2026-09-26 for the serveRedemption window-closed fix", () => {
    // Addresses updated 2026-09-26: the original 2026-09-25 trio (0xC403.../0x88fb.../0x7583...,
    // still recorded under redeployment.previousTrio in the deployment JSON — see that record's
    // own doc comment and data/gate-market/first-real-default-2026-09-26.json for why) was
    // retired when serveRedemption gained its window-closed guard, requiring the whole
    // mutually-address-pinned trio to redeploy together.
    const deployment = loadGateMarketDeployment();
    expect(deployment.network).toMatchObject({ name: "Base Sepolia", chainId: 84532 });
    expect(deployment.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(deployment.capacityBond.address).toBe("0xa053bd236954C6633cBB902a1eA46a125F565060");
    expect(deployment.claimRouter.address).toBe("0xaec219812145a4150E510b62e64F6A4f19F52D51");
    expect(deployment.workClaim.address).toBe("0xD3cC27A711B1eF3893975927cfE86d651a35337B");
  });
});
