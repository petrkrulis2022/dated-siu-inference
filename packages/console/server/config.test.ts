import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { resolveVerifyOptions, type ConsoleConfig } from "./config.js";

function fakePrint(overrides: Partial<Print> = {}): Print {
  return {
    version: "SIU-2026a",
    print_id: "2026-08-17",
    date: "2026-08-17",
    status: "provisional",
    basket_costs: [{ model_id: "m1", cost_usd: "0.01" }],
    weights: { source: "equal", values: [{ model_id: "m1", weight: "1" }] },
    dated_siu: "0.01",
    exchange_rate_table: [
      { model_id: "m1", usd_per_siu: "0.01", spread_to_index: "0", siu_per_usd: "100" },
    ],
    sensitivity_block: [{ policy_variant: "baseline", dated_siu: "0.01", delta: "0" }],
    rounding: {
      dated_siu_dp: 4,
      basket_cost_dp: 6,
      usd_per_siu_dp: 4,
      spread_dp: 4,
      siu_per_usd_dp: 1,
      mode: "ROUND_HALF_UP",
      siu_per_usd_mode: "ROUND_DOWN",
    },
    cost_of_production_usd: "3.00",
    price_snapshot_ref: "price-snapshot-openrouter-x.json",
    methodology_version: "v0",
    signature: `0x${"1".repeat(128)}`,
    public_key: `0x${"2".repeat(66)}`,
    ...overrides,
  } as Print;
}

const FAKE_DEFAULT_CONFIG: ConsoleConfig = {
  port: 5274,
  host: "127.0.0.1",
  chainName: "base-sepolia",
  chainId: 84532,
  rpcUrl: "https://default-configured-chain.example/rpc",
  explorerBaseUrl: "https://base-sepolia.blockscout.com",
  escrowAddress: "0xEscrow",
  escrowDeployBlock: 0n,
  attestationAddress: "0xDefaultChainAttestation",
  attestationDeployBlock: 0n,
  publisherAddress: null,
  printsDir: "/tmp/prints",
  runsDirRoot: "/tmp/runs",
  registryDir: "/tmp/registry",
  eventCachePath: "/tmp/events.json",
  localQuotesDir: "/tmp/quotes",
};

describe("resolveVerifyOptions", () => {
  const savedArcRpcUrl = process.env.ARC_TESTNET_RPC_URL;

  beforeEach(() => {
    process.env.ARC_TESTNET_RPC_URL = "https://arc-testnet.example/rpc";
  });

  afterEach(() => {
    if (savedArcRpcUrl === undefined) delete process.env.ARC_TESTNET_RPC_URL;
    else process.env.ARC_TESTNET_RPC_URL = savedArcRpcUrl;
  });

  it("uses the console's own configured chain when the print matches it", () => {
    const print = fakePrint({ anchor: { chain: "base-sepolia", status: "anchored", tx_hash: "0xa" } });
    const options = resolveVerifyOptions(print, FAKE_DEFAULT_CONFIG);
    expect(options).toEqual({
      rpcUrl: FAKE_DEFAULT_CONFIG.rpcUrl,
      attestationAddress: FAKE_DEFAULT_CONFIG.attestationAddress,
    });
  });

  it("resolves the print's OWN chain, not the console's default, when they differ — the actual bug fix", () => {
    const print = fakePrint({ anchor: { chain: "arc-testnet", status: "anchored", tx_hash: "0xa" } });
    const options = resolveVerifyOptions(print, FAKE_DEFAULT_CONFIG);
    // Real data/deployments/arc-testnet.json's TouchstoneAttestation address — confirms this
    // reads the real deployment record, not a guess, and never the default chain's address.
    expect(options.attestationAddress).toBe("0x12b886b043feABc3d90bBae3ae206d22b208160d");
    expect(options.attestationAddress).not.toBe(FAKE_DEFAULT_CONFIG.attestationAddress);
    expect(options.rpcUrl).toBe("https://arc-testnet.example/rpc");
  });

  it("falls back to the console's default chain for a never-anchored print (no anchor field at all)", () => {
    const print = fakePrint({ anchor: undefined });
    const options = resolveVerifyOptions(print, FAKE_DEFAULT_CONFIG);
    expect(options).toEqual({
      rpcUrl: FAKE_DEFAULT_CONFIG.rpcUrl,
      attestationAddress: FAKE_DEFAULT_CONFIG.attestationAddress,
    });
  });

  it("still resolves the print's own chain for a failed or stub anchor attempt, honestly reporting nothing found there rather than checking the wrong chain", () => {
    const print = fakePrint({ anchor: { chain: "arc-testnet", status: "failed" } });
    const options = resolveVerifyOptions(print, FAKE_DEFAULT_CONFIG);
    expect(options.attestationAddress).toBe("0x12b886b043feABc3d90bBae3ae206d22b208160d");
  });

  it("throws a clear error rather than silently falling back, when the print's chain has no RPC env var configured", () => {
    delete process.env.ARC_TESTNET_RPC_URL;
    const print = fakePrint({ anchor: { chain: "arc-testnet", status: "anchored", tx_hash: "0xa" } });
    expect(() => resolveVerifyOptions(print, FAKE_DEFAULT_CONFIG)).toThrow(/ARC_TESTNET_RPC_URL/);
  });
});
