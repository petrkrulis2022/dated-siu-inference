import { describe, expect, it } from "vitest";
import { LOT_CREATION_ORDER } from "./deploy.js";
import { AGENT_IDS } from "../identity/resolve.js";

describe("lot creation order is pinned, because routing depends on it (spec §3.5a, §4.6g)", () => {
  it("creates ISSUER-A's lot first, so first-fit routes to the small issuer", () => {
    // CapacityBond pushes an issuer onto issuersForClass on its FIRST createLot, and
    // ClaimRouter.route returns the first entry with enough headroom. ISSUER-A's lot is
    // deliberately smaller than a standard job so it takes the undersized window-1 job and
    // can never win routing again. Create ISSUER-B first and that inverts: B takes every
    // claim, every claim is served, and the default path is never exercised.
    expect(LOT_CREATION_ORDER[0]).toBe("ISSUER-A");
    expect(LOT_CREATION_ORDER[1]).toBe("ISSUER-B");
  });

  it("does not silently follow AGENT_IDS, whose order is incidental to other callers", () => {
    // If someone re-sorts AGENT_IDS for an unrelated reason, routing must not move with it.
    expect(LOT_CREATION_ORDER).not.toBe(AGENT_IDS);
    expect([...LOT_CREATION_ORDER]).toEqual(["ISSUER-A", "ISSUER-B"]);
  });
});
