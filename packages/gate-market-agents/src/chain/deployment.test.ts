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
    // Addresses updated 2026-09-28: the third trio (0x8582.../0x1A1D.../0x0dF1..., now recorded
    // under redeployment.previousTrio in the deployment JSON; the two older trios are recorded
    // one and two levels deeper under redeployment.priorRedeployment) was retired when
    // `reserveForWork`/`releaseReservation` were added, so that USDC-paid work draws on the same
    // bonded headroom a minted claim does. The whole mutually-address-pinned trio has to
    // redeploy together — `CapacityBond` takes WorkClaim's address as an immutable. The same
    // deploy resized both issuers' lots (60,000/40,000 -> 24,000/16,000 mSIU per class), which
    // would have required a redeploy on its own: `createLot` reverts `LotExists`, so a lot is
    // immutable once made.
    const deployment = loadGateMarketDeployment();
    expect(deployment.network).toMatchObject({ name: "Base Sepolia", chainId: 84532 });
    expect(deployment.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
    expect(deployment.capacityBond.address).toBe("0xa76967016ae221Ab22d58471f7CB9c6Dae57634e");
    expect(deployment.claimRouter.address).toBe("0x277b67694aba7bd0988d85dE888fBf7053295AE1");
    expect(deployment.workClaim.address).toBe("0xe0D9B879F9841ef6Be5Af9001ed8F015030324A4");
  });
});
