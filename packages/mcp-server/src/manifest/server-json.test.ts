import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAINNET_PAYMENT_NETWORKS, REGISTRY_DESCRIPTION } from "@touchstone/print";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "server.json"), "utf-8")) as {
  description: string;
  version: string;
  remotes: { url: string }[];
};

describe("server.json (the MCP registry manifest)", () => {
  it("describes payment on the live mainnet networks, within the registry's 100-character limit", () => {
    expect(manifest.description).toBe(REGISTRY_DESCRIPTION);
    expect(manifest.description.length).toBeLessThanOrEqual(100);
    expect(manifest.description).toContain("USDC");
    for (const n of MAINNET_PAYMENT_NETWORKS) expect(manifest.description).toContain(n.name);
    expect(manifest.description).not.toMatch(/sepolia|testnet|testbed/i);
  });

  it("is version 0.2.0, the first update after the registry's 0.1.0", () => {
    expect(manifest.version).toBe("0.2.0");
  });

  it("points at the live endpoint", () => {
    expect(manifest.remotes.map((r) => r.url)).toEqual(["https://mcp.touchstoneassay.com/mcp"]);
  });
});
