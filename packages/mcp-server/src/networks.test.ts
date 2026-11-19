import { describe, expect, it } from "vitest";
import {
  NETWORK_PROFILES,
  PROFILES,
  PROFILE_KV_KEY,
  SAFE_FALLBACK_PROFILE,
  parseProfile,
  resolveProfile,
  type KvReader,
} from "./networks.js";

const kv = (value: string | null | Error): KvReader => ({
  get: async (key) => {
    expect(key).toBe(PROFILE_KV_KEY);
    if (value instanceof Error) throw value;
    return value;
  },
});

describe("PROFILES", () => {
  it("mainnet: Base 8453 and Arc 5042 through Circle's live Gateway, Kite 2366 settled here", () => {
    const p = PROFILES.mainnet;
    expect(p.circle.networks).toEqual(["eip155:8453", "eip155:5042"]);
    expect(p.circle.facilitatorUrl).toBe("https://gateway-api.circle.com");
    expect(p.selfSettled.map((n) => n.network)).toEqual(["eip155:2366"]);
  });

  it("testnet: Base Sepolia, Arc Testnet and Kite Testnet, through Circle's TESTNET Gateway", () => {
    const p = PROFILES.testnet;
    expect(p.circle.networks).toEqual(["eip155:84532", "eip155:5042002"]);
    expect(p.circle.facilitatorUrl).toBe("https://gateway-api-testnet.circle.com");
    expect(p.selfSettled.map((n) => n.network)).toEqual(["eip155:2368"]);
  });

  it("base-sepolia is exactly the pre-switch behaviour: Base Sepolia only, nothing self-settled", () => {
    const p = PROFILES["base-sepolia"];
    expect(p.circle.networks).toEqual(["eip155:84532"]);
    expect(p.circle.facilitatorUrl).toBe("https://gateway-api-testnet.circle.com");
    expect(p.selfSettled).toEqual([]);
    expect(p.unavailableTools).toEqual({});
  });

  it("a mainnet profile never points at a testnet Gateway, and a testnet profile never at the live one", () => {
    expect(PROFILES.mainnet.circle.facilitatorUrl).not.toContain("testnet");
    for (const t of ["testnet", "base-sepolia"] as const) {
      expect(PROFILES[t].circle.facilitatorUrl).toContain("testnet");
    }
  });

  it("holds verify_receipt back on mainnet only, with a reason that says the caller was not charged", () => {
    expect(Object.keys(PROFILES.mainnet.unavailableTools)).toEqual(["verify_receipt"]);
    expect(PROFILES.mainnet.unavailableTools.verify_receipt).toMatch(/not charged/);
    expect(PROFILES.testnet.unavailableTools).toEqual({});
  });

  it("has an entry for every named profile", () => {
    expect(Object.keys(PROFILES).sort()).toEqual([...NETWORK_PROFILES].sort());
  });
});

describe("parseProfile", () => {
  it("accepts the three names, trimmed and in any case", () => {
    expect(parseProfile("mainnet")).toBe("mainnet");
    expect(parseProfile("  TestNet ")).toBe("testnet");
    expect(parseProfile("BASE-SEPOLIA")).toBe("base-sepolia");
  });

  it("refuses everything else, including near misses", () => {
    for (const v of ["", "main", "mainnet2", "prod", "base", "arc", undefined, null, 1, {}]) {
      expect(parseProfile(v)).toBeUndefined();
    }
  });
});

describe("resolveProfile", () => {
  it("the KV flag wins over the env default", async () => {
    expect(await resolveProfile(kv("mainnet"), "testnet")).toBe("mainnet");
    expect(await resolveProfile(kv("base-sepolia"), "mainnet")).toBe("base-sepolia");
  });

  it("an unset or invalid KV flag falls back to the env default", async () => {
    expect(await resolveProfile(kv(null), "base-sepolia")).toBe("base-sepolia");
    expect(await resolveProfile(kv("garbage"), "mainnet")).toBe("mainnet");
  });

  it("a KV outage falls back to the env default instead of failing the request", async () => {
    expect(await resolveProfile(kv(new Error("KV unavailable")), "testnet")).toBe("testnet");
  });

  it("with no KV binding at all, the env default decides", async () => {
    expect(await resolveProfile(undefined, "base-sepolia")).toBe("base-sepolia");
  });

  it("can only reach mainnet when something says exactly 'mainnet': every failure lands on a testnet profile", async () => {
    expect(SAFE_FALLBACK_PROFILE).toBe("testnet");
    for (const [store, def] of [
      [kv(null), undefined],
      [kv(null), ""],
      [kv(null), "mainnet "] as const, // trimmed: this one IS valid, asserted below
      [kv("MAINNET!"), "typo"],
      [kv(new Error("down")), "nonsense"],
      [undefined, "main"],
    ] as const) {
      const got = await resolveProfile(store, def);
      if (def === "mainnet ") expect(got).toBe("mainnet");
      else expect(got).toBe("testnet");
    }
  });
});
