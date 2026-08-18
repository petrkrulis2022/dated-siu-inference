import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadDeployment } from "./load.js";

function validRecord() {
  return {
    network: {
      name: "Base Sepolia",
      chainId: 84532,
      explorer: "https://base-sepolia.blockscout.com",
    },
    contracts: {
      TouchstoneAttestation: { address: "0xAAA", explorerUrl: "https://example/AAA" },
      TouchstoneEscrow: { address: "0xBBB", explorerUrl: "https://example/BBB" },
    },
    usdc: { address: "0xCCC", decimals: 6, source: "test" },
  };
}

describe("loadDeployment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "touchstone-deployments-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a well-formed deployment record", async () => {
    await writeFile(join(dir, "base-sepolia.json"), JSON.stringify(validRecord()));
    const record = loadDeployment("base-sepolia", dir);
    expect(record.network.chainId).toBe(84532);
    expect(record.contracts.TouchstoneAttestation.address).toBe("0xAAA");
    expect(record.contracts.TouchstoneEscrow.address).toBe("0xBBB");
    expect(record.usdc.address).toBe("0xCCC");
  });

  it("throws a clear error when the file does not exist", () => {
    expect(() => loadDeployment("nonexistent-network", dir)).toThrow(
      /Could not read deployment record/,
    );
  });

  it("throws when the record is missing required fields, rather than returning undefined addresses", async () => {
    await writeFile(join(dir, "broken.json"), JSON.stringify({ network: { chainId: 1 } }));
    expect(() => loadDeployment("broken", dir)).toThrow(/Malformed deployment record/);
  });

  it("loads the real committed base-sepolia.json", () => {
    const record = loadDeployment("base-sepolia", "../../data/deployments");
    expect(record.network.chainId).toBe(84532);
    expect(record.contracts.TouchstoneAttestation.address).toBe(
      "0xF60701793eD168ffd6e818e1DCcb600393297190",
    );
    expect(record.contracts.TouchstoneEscrow.address).toBe(
      "0x3eC06FFe8d5250d5Edf8Fff26b163aaaD65c8a00",
    );
    expect(record.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });
});
