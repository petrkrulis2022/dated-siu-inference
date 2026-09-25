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

  it("loads the real Base Sepolia deployment — deployed and verified 2026-09-25 (WP-7)", () => {
    const deployment = loadGateMarketDeployment();
    expect(deployment.network).toMatchObject({ name: "Base Sepolia", chainId: 84532 });
    expect(deployment.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(deployment.capacityBond.address).toBe("0xC4030792e815e6D08Ae5f434B84A3DCCa2FBe999");
    expect(deployment.claimRouter.address).toBe("0x88fbBF79727bB3c903D5C94a860033959Ba88Ec8");
    expect(deployment.workClaim.address).toBe("0x7583BB12751F0EA622F5Aa8F69df37c1506F9061");
  });
});
