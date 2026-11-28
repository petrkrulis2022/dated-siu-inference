import { describe, expect, it } from "vitest";
import { GATEWAY, type GatewayChain } from "./gateway-withdrawal.js";
import { HARDWARE_WALLET_THRESHOLD_USDC, hardwareWalletAlert, readTreasuryTotal } from "./treasury-total.js";

const TREASURY = "0xB514882859f43DbF3df664C899D707f649E0CF4A";

describe("readTreasuryTotal", () => {
  it("adds the treasury's Gateway balances and wallet USDC on Base and Arc mainnet, exactly", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      asked.push(String(url));
      const body = JSON.parse(String(init?.body));
      expect(body.sources).toEqual([
        { domain: 6, depositor: TREASURY },
        { domain: 26, depositor: TREASURY },
      ]);
      return new Response(JSON.stringify({ token: "USDC", balances: [{ domain: 6, depositor: TREASURY, balance: "0.003000" }, { domain: 26, depositor: TREASURY, balance: "60.000001" }] }));
    }) as typeof fetch;
    const rpc = async (chain: GatewayChain, method: string, params: unknown[]) => {
      expect(method).toBe("eth_call");
      const call = params[0] as { to: string; data: string };
      expect(call.to).toBe(chain.usdc);
      expect(call.data).toBe(`0x70a08231${TREASURY.slice(2).toLowerCase().padStart(64, "0")}`);
      return chain.key === "base" ? `0x${(40_000_000).toString(16)}` : "0x0";
    };
    const { parts, total } = await readTreasuryTotal({ treasury: TREASURY, fetchImpl, rpc });
    expect(asked).toEqual([`${GATEWAY.mainnet.api}/v1/balances`]);
    expect(parts).toEqual([
      { where: "Gateway balance on Base", amount: 3_000n },
      { where: "Gateway balance on Arc", amount: 60_000_001n },
      { where: "wallet on Base", amount: 40_000_000n },
      { where: "wallet on Arc", amount: 0n },
    ]);
    expect(total).toBe(100_003_001n);
  });

  it("refuses an answer from Circle without the balances, rather than counting zero", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: "nope" }))) as unknown as typeof fetch;
    await expect(readTreasuryTotal({ treasury: TREASURY, fetchImpl, rpc: async () => "0x0" })).rejects.toThrow(/balances/);
  });
});

describe("hardwareWalletAlert", () => {
  it("is set at $100: the owner's decision of 2026-11-28", () => {
    expect(HARDWARE_WALLET_THRESHOLD_USDC).toBe(100_000_000n);
  });

  it("alerts once the total is more than $100, saying it is time for a hardware wallet", () => {
    const message = hardwareWalletAlert({ total: 100_000_001n, lastAlertDay: undefined, today: "2026-12-01" });
    expect(message).toMatch(/100\.000001 USDC/);
    expect(message).toMatch(/time to move the treasury to a hardware wallet/);
  });

  it("stays quiet at exactly $100 and below", () => {
    expect(hardwareWalletAlert({ total: 100_000_000n, lastAlertDay: undefined, today: "2026-12-01" })).toBeUndefined();
    expect(hardwareWalletAlert({ total: 6_000n, lastAlertDay: undefined, today: "2026-12-01" })).toBeUndefined();
  });

  it("alerts once per UTC day while the total stays above, so the switch is not forgotten", () => {
    expect(hardwareWalletAlert({ total: 150_000_000n, lastAlertDay: "2026-12-01", today: "2026-12-01" })).toBeUndefined();
    expect(hardwareWalletAlert({ total: 150_000_000n, lastAlertDay: "2026-12-01", today: "2026-12-02" })).toBeDefined();
  });
});
