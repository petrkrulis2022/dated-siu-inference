import { describe, expect, it, vi } from "vitest";
import { paywallOptionsFor } from "./paywall-factory.js";
import type { SelfSettler } from "../self-settled.js";

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

  it("mainnet asks Circle's live Gateway about Base and Arc, and settles Kite itself with the configured key", () => {
    const made: [string, string][] = [];
    const o = paywallOptionsFor("mainnet", env({ KITE_SETTLER_PRIVATE_KEY: "0xkey" }), (n, k) => {
      made.push([n.network, k]);
      return fakeSettler;
    });
    expect(o.networks).toEqual(["eip155:8453", "eip155:5042"]);
    expect(o.facilitatorUrl).toBe("https://gateway-api.circle.com");
    expect(o.selfSettled?.networks.map((n) => n.network)).toEqual(["eip155:2366"]);
    expect(Object.keys(o.selfSettled?.settlers ?? {})).toEqual(["eip155:2366"]);
    expect(made).toEqual([["eip155:2366", "0xkey"]]);
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
