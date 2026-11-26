import { describe, expect, it } from "vitest";
import {
  MAINNET_PAYMENT_NETWORKS,
  MAINNET_UNAVAILABLE_TOOLS,
  PAYMENT_ROUTE,
  SIU_PRICE_DOCS_URL,
  paymentNetworksText,
} from "./paid-tools.js";

describe("the paid tools' public facts", () => {
  it("lists exactly the networks live on mainnet: Base and Arc, in USDC, through Circle Gateway", () => {
    expect(MAINNET_PAYMENT_NETWORKS.map((n) => [n.name, n.caip2, n.assetAddress])).toEqual([
      ["Base", "eip155:8453", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      ["Arc", "eip155:5042", "0x3600000000000000000000000000000000000000"],
    ]);
    expect(PAYMENT_ROUTE).toMatch(/Circle Gateway/);
  });

  it("offers no testnet and no Kite as a payment network", () => {
    const text = JSON.stringify({
      MAINNET_PAYMENT_NETWORKS,
      PAYMENT_ROUTE,
      sentence: paymentNetworksText(),
    });
    expect(text).not.toMatch(/sepolia|testnet|84532|5042002|kite|2366/i);
  });

  it("says verify_receipt is not available on mainnet yet, and that the caller is not charged", () => {
    expect(MAINNET_UNAVAILABLE_TOOLS.verify_receipt).toMatch(/not available on mainnet yet/);
    expect(MAINNET_UNAVAILABLE_TOOLS.verify_receipt).toMatch(/You were not charged/);
  });

  it("states the networks in one sentence every page reuses", () => {
    expect(paymentNetworksText()).toBe(
      "USDC on Base (eip155:8453) and Arc (eip155:5042) mainnet, over x402 through Circle Gateway (batched nanopayments)",
    );
  });

  it("points at the documentation of the 402's SIU price block", () => {
    expect(SIU_PRICE_DOCS_URL).toMatch(/^https:\/\/github\.com\/.+#the-siu-price-in-every-402$/);
  });
});
