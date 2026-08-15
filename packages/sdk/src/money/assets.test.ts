import { describe, expect, it } from "vitest";
import { usdcAddressFor } from "./assets.js";

describe("usdcAddressFor", () => {
  it("resolves the known Base mainnet USDC address", () => {
    expect(usdcAddressFor("base")).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  });

  it("returns undefined for an unknown chain rather than guessing", () => {
    expect(usdcAddressFor("ethereum")).toBeUndefined();
  });
});
