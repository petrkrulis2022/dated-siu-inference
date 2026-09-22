import { describe, expect, it } from "vitest";
import { loadGateMarketDeployment } from "./deployment.js";

describe("loadGateMarketDeployment", () => {
  it("throws an actionable error — CapacityBond/ClaimRouter/WorkClaim aren't deployed yet", () => {
    // Confirms the honest, current repo state (see this package's plan's own "What already
    // exists" section): no data/deployments/base-sepolia-gate-market.json exists. Fails loudly
    // rather than returning placeholder addresses, matching StubSettlementReader's precedent.
    expect(() => loadGateMarketDeployment()).toThrow(/not been deployed to Base Sepolia yet/);
  });
});
