import { describe, expect, it } from "vitest";
import { loadPublisherKeyFromEnv, loadSellerAddressFromEnv } from "./env.js";

describe("loadPublisherKeyFromEnv", () => {
  it("returns the key when set", () => {
    expect(loadPublisherKeyFromEnv({ TOUCHSTONE_PUBLISHER_KEY: "0xabc" })).toBe("0xabc");
  });

  it("throws rather than defaulting when unset", () => {
    expect(() => loadPublisherKeyFromEnv({})).toThrow(/TOUCHSTONE_PUBLISHER_KEY/);
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
