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
      DatumAttestation: { address: "0xAAA", explorerUrl: "https://example/AAA" },
      DatumEscrow: { address: "0xBBB", explorerUrl: "https://example/BBB" },
    },
    usdc: { address: "0xCCC", decimals: 6, source: "test" },
  };
}

describe("loadDeployment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "datum-deployments-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a well-formed deployment record", async () => {
    await writeFile(join(dir, "base-sepolia.json"), JSON.stringify(validRecord()));
    const record = loadDeployment("base-sepolia", dir);
    expect(record.network.chainId).toBe(84532);
    expect(record.contracts.DatumAttestation.address).toBe("0xAAA");
    expect(record.contracts.DatumEscrow.address).toBe("0xBBB");
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
    expect(record.contracts.DatumAttestation.address).toBe(
      "0xBd8C6F2A9B71DaB2E4b7B3a0e9efA0a0F25301fF",
    );
    expect(record.contracts.DatumEscrow.address).toBe("0xb9708BC05B15efC9dB494b2013125A44dc614757");
    expect(record.usdc.address).toBe("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
  });
});
