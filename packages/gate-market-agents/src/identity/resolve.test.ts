import { describe, expect, it } from "vitest";
import { publicKeyFor } from "@touchstone/sdk";
import { AGENT_IDS, buildAgentRosterResolver, erc8004IdFor } from "./resolve.js";

const KEY_A = "0x7ea2a69f7b42fd0a1d3e901cac8d37e76a96075b663fa5f56950bf009c49f44b";
const ADDRESS_A = "0x0000000000000000000000000000000000aaaa";

describe("erc8004IdFor", () => {
  it("builds the same string convention packages/agents/src/seller.ts's sellerIdFor() uses", () => {
    expect(erc8004IdFor(ADDRESS_A)).toBe(`erc8004:${ADDRESS_A}`);
  });
});

describe("buildAgentRosterResolver", () => {
  it("resolves a roster agent's erc8004 id to its real public key", async () => {
    const resolver = buildAgentRosterResolver({ ORCHESTRATOR: KEY_A }, { ORCHESTRATOR: ADDRESS_A });
    const resolved = await resolver.resolve(erc8004IdFor(ADDRESS_A));
    expect(resolved).not.toBeNull();
    expect(resolved?.publicKey).toBe(publicKeyFor(KEY_A));
    expect(resolved?.source).toBe("static-allowlist");
  });

  it("resolves nothing for an agent whose key/address wasn't supplied", async () => {
    const resolver = buildAgentRosterResolver({}, {});
    const resolved = await resolver.resolve(erc8004IdFor(ADDRESS_A));
    expect(resolved).toBeNull();
  });

  it("covers all six roster agents", () => {
    expect(AGENT_IDS).toEqual([
      "ISSUER-A",
      "ISSUER-B",
      "ORCHESTRATOR",
      "WORKER-CODE",
      "WORKER-EXTRACT",
      "HEDGER",
    ]);
  });
});
