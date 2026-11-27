import { describe, expect, it, vi } from "vitest";
import { paywallOptionsFor, remembered, siuDecimalsFor } from "./paywall-factory.js";
import type { SelfSettler } from "../self-settled.js";

describe("siuDecimalsFor", () => {
  it("knows every network each profile offers: USDC's 6 on Circle's, the token's own on Kite", () => {
    const mainnet = siuDecimalsFor("mainnet");
    expect(["eip155:8453", "eip155:5042"].map(mainnet)).toEqual([6, 6]);
    expect(mainnet("eip155:2366")).toBeUndefined(); // Kite mainnet is not offered yet
    const testnet = siuDecimalsFor("testnet");
    expect(["eip155:84532", "eip155:5042002", "eip155:2368"].map(testnet)).toEqual([6, 6, 18]);
    expect(mainnet("eip155:84532")).toBeUndefined();
  });
});

describe("remembered", () => {
  it("reuses a loaded value within its lifetime, reloads after it, and never keeps a failure", async () => {
    let now = 0;
    let loads = 0;
    let fail = true;
    const load = remembered(
      1000,
      async () => {
        loads++;
        if (fail) throw new Error("KV down");
        return loads;
      },
      () => now,
    );
    await expect(load()).rejects.toThrow("KV down");
    fail = false;
    expect(await load()).toBe(2);
    now = 999;
    expect(await load()).toBe(2);
    now = 1000;
    expect(await load()).toBe(3);
  });
});

const TREASURY = "0xB514882859f43DbF3df664C899D707f649E0CF4A";
const fakeSettler: SelfSettler = { verifyAndSettle: async () => ({ ok: false, reason: "test" }) };
const env = (extra: Record<string, string> = {}) => ({
  TOUCHSTONE_SELLER_ADDRESS: TREASURY,
  KITE_SETTLER_PRIVATE_KEY: undefined as string | undefined,
  CIRCLE_LIVE_API_KEY: undefined as string | undefined,
  ...extra,
});

describe("paywallOptionsFor", () => {
  it("every profile pays the treasury", () => {
    for (const p of ["mainnet", "testnet", "base-sepolia"] as const) {
      expect(paywallOptionsFor(p, env(), () => fakeSettler).sellerAddress).toBe(TREASURY);
    }
  });

  it("mainnet asks Circle's live Gateway about Base and Arc, and offers no Kite even with the settler key set", () => {
    const makeSettler = vi.fn(() => fakeSettler);
    const o = paywallOptionsFor("mainnet", env({ KITE_SETTLER_PRIVATE_KEY: "0xkey" }), makeSettler);
    expect(o.networks).toEqual(["eip155:8453", "eip155:5042"]);
    expect(o.facilitatorUrl).toBe("https://gateway-api.circle.com");
    expect(o.selfSettled).toBeUndefined();
    expect(makeSettler).not.toHaveBeenCalled();
  });

  it("testnet still settles Kite Testnet itself with the configured key", () => {
    const made: [string, string][] = [];
    const o = paywallOptionsFor("testnet", env({ KITE_SETTLER_PRIVATE_KEY: "0xkey" }), (n, k) => {
      made.push([n.network, k]);
      return fakeSettler;
    });
    expect(o.selfSettled?.networks.map((n) => n.network)).toEqual(["eip155:2368"]);
    expect(made).toEqual([["eip155:2368", "0xkey"]]);
  });

  it("without a settler key Kite is left OUT rather than advertised and then refused, and the caller is told", () => {
    const skipped: string[] = [];
    const makeSettler = vi.fn(() => fakeSettler);
    const o = paywallOptionsFor("testnet", env(), makeSettler, (n) => skipped.push(n));
    expect(o.selfSettled).toBeUndefined();
    expect(makeSettler).not.toHaveBeenCalled();
    expect(skipped).toEqual(["eip155:2368"]);
    expect(o.networks).toEqual(["eip155:84532", "eip155:5042002"]); // Circle's networks unaffected
  });

  it("base-sepolia never involves a settler, even when the key is set", () => {
    const makeSettler = vi.fn(() => fakeSettler);
    const o = paywallOptionsFor(
      "base-sepolia",
      env({ KITE_SETTLER_PRIVATE_KEY: "0xkey" }),
      makeSettler,
    );
    expect(o.selfSettled).toBeUndefined();
    expect(makeSettler).not.toHaveBeenCalled();
    expect(o.networks).toEqual(["eip155:84532"]);
  });

  it("sends Circle's key as a bearer token only when one is configured", () => {
    expect(paywallOptionsFor("mainnet", env(), () => fakeSettler).headers).toBeUndefined();
    expect(
      paywallOptionsFor("mainnet", env({ CIRCLE_LIVE_API_KEY: "sk_test_abc" }), () => fakeSettler)
        .headers,
    ).toEqual({ Authorization: "Bearer sk_test_abc" });
  });
});
