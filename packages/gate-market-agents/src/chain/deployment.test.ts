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

  it("loads the real Base Sepolia deployment — redeployed 2026-09-27 for the series (grade) discriminant", () => {
    // Addresses updated 2026-09-27: the second trio (0xa053.../0xaec2.../0xD3cC..., still
    // recorded under redeployment.previousTrio in the deployment JSON — the first trio,
    // 0xC403.../0x88fb.../0x7583..., is recorded one level deeper under
    // redeployment.priorRedeployment.previousTrio) was retired when `series` was added as a
    // discriminant across ClaimType/tokenIdFor/RateAttestation, requiring the whole
    // mutually-address-pinned trio to redeploy together.
    const deployment = loadGateMarketDeployment();
    expect(deployment.network).toMatchObject({ name: "Base Sepolia", chainId: 84532 });
    expect(deployment.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(deployment.capacityBond.address).toBe("0x8582a738A810666f6CA5c4877710bbc55dF94434");
    expect(deployment.claimRouter.address).toBe("0x1A1DC8061617d78f2a037Ed3f3AFB2F0fd07123f");
    expect(deployment.workClaim.address).toBe("0x0dF15076d534896D375D80b87E0243b4C83131Fc");
  });
});
