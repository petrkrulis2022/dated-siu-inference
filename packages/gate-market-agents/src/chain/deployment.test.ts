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

  it("loads the real Base Sepolia deployment — the fifth trio, redeployed 2026-09-29 to resize capacity", () => {
    // Addresses updated 2026-09-29. Unlike every earlier redeploy this one changed no bytecode:
    // the contracts are identical to the fourth trio's and only the LOTS are new, at 800
    // committedCapacityHours against 400. Three windows now carry two independent purchases each
    // (gate authoring 10,000 mSIU, adversarial testing 4,000), so worst-case demand is 42,000
    // before the external buyer's takes — more than the fourth trio's remaining 31,000 could
    // cover, which would have exhausted the pool in window 2 and cost most of the run's
    // asset-choice decisions.
    //
    // A redeploy was the only route: `CapacityBond.createLot` is one lot per (issuer, class)
    // forever and reverts `LotExists`, with no top-up path by design, and `bondedUsdc` plays no
    // part in `issuanceLimit` — so adding collateral raises the default-paying bond and moves
    // headroom by exactly zero. The retiring trio's closing state (both bonds after five real
    // defaults, the holder's USDC, the conservation check) is recorded under
    // redeployment.retiredTrio in the deployment JSON; older trios nest below it.
    const deployment = loadGateMarketDeployment();
    expect(deployment.network).toMatchObject({ name: "Base Sepolia", chainId: 84532 });
    expect(deployment.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(deployment.capacityBond.address).toBe("0x88034c6d644c9eeaB1823c80a00f54CF1c042bf1");
    expect(deployment.claimRouter.address).toBe("0xeda362D1C7e1Ca2089a9331527FB028d09Dfa24d");
    expect(deployment.workClaim.address).toBe("0xc2e058E55211F460556E60a45963Ea3a3C31a898");
  });
});
