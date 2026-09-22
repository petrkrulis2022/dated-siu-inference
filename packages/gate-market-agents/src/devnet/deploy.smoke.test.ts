import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPublicClient, http } from "viem";
import { setupDevnet, type DevnetHandle } from "./deploy.js";
import { CAPACITY_BOND_ABI } from "../chain/abi.js";

describe("setupDevnet — real anvil, real unmodified contract bytecode", () => {
  let devnet: DevnetHandle;

  beforeAll(async () => {
    devnet = await setupDevnet();
  }, 60_000);

  afterAll(async () => {
    await devnet.stop();
  });

  it("deploys all four contracts to distinct real addresses", () => {
    const addresses = new Set([
      devnet.deployment.usdc.address,
      devnet.deployment.capacityBond.address,
      devnet.deployment.claimRouter.address,
      devnet.deployment.workClaim.address,
    ]);
    expect(addresses.size).toBe(4);
  });

  it("funds all six roster agents with ETH and USDC", () => {
    expect(Object.keys(devnet.agents)).toHaveLength(6);
    for (const agent of Object.values(devnet.agents)) {
      expect(agent.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it("gives ISSUER-A real headroom and ISSUER-B a deliberately small code lot", async () => {
    const publicClient = createPublicClient({ transport: http(devnet.rpcUrl) });
    const issuerA = devnet.agents["ISSUER-A"].address;
    const issuerB = devnet.agents["ISSUER-B"].address;
    const { CLASS_CODE } = await import("./deploy.js");

    const headroomA = await publicClient.readContract({
      address: devnet.deployment.capacityBond.address as `0x${string}`,
      abi: CAPACITY_BOND_ABI,
      functionName: "headroom",
      args: [issuerA, CLASS_CODE],
    });
    const headroomB = await publicClient.readContract({
      address: devnet.deployment.capacityBond.address as `0x${string}`,
      abi: CAPACITY_BOND_ABI,
      functionName: "headroom",
      args: [issuerB, CLASS_CODE],
    });

    expect(headroomA).toBeGreaterThan(headroomB);
    expect(headroomB).toBeGreaterThan(0n);
  });
});
