import { describe, expect, it } from "vitest";
import { loadAttestationKeyFromEnv, loadSellerAddressFromEnv } from "./env.js";

describe("loadAttestationKeyFromEnv", () => {
  it("returns the key when set", () => {
    expect(loadAttestationKeyFromEnv({ TOUCHSTONE_ATTESTATION_KEY: "0xabc" })).toBe("0xabc");
  });

  it("throws rather than defaulting when unset", () => {
    expect(() => loadAttestationKeyFromEnv({})).toThrow(/TOUCHSTONE_ATTESTATION_KEY/);
  });
});

describe("loadSellerAddressFromEnv", () => {
  it("returns the address when set", () => {
    expect(loadSellerAddressFromEnv({ TOUCHSTONE_SELLER_ADDRESS: "0xdead" })).toBe("0xdead");
  });

  it("throws rather than defaulting when unset", () => {
    expect(() => loadSellerAddressFromEnv({})).toThrow(/TOUCHSTONE_SELLER_ADDRESS/);
  });
});
