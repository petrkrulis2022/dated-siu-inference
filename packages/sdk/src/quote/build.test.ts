import { describe, expect, it } from "vitest";
import {
  buildQuoteBody,
  QUOTE_SCHEMA_VERSION,
  MINIMUM_QUOTABLE_USD,
  type QuoteBuildInput,
} from "./build.js";

const BASE: Omit<QuoteBuildInput, "pattern" | "siuMax"> = {
  siu: "1.000",
  model: "registry-id",
  rateUsdPerSiu: "0.0483",
  indexVersion: "SIU-2026a",
  printId: "2026-08-14",
  printHash: "0xabc123",
  sellerId: "erc8004:0xSellerAddress",
  chain: "base",
  expiresInSeconds: 300,
  now: new Date("2026-08-15T00:00:00Z"),
};

describe("buildQuoteBody", () => {
  it("reproduces build1-spec.md §8's own illustrative example (siu_max 1.400 × rate 0.0483 = 0.0676)", () => {
    const body = buildQuoteBody({ ...BASE, pattern: "estimate", siuMax: "1.400" });
    expect(body.amount_usd_max).toBe("0.0676");
  });

  it("computes amount_usd_max from siu_max for a cap pattern, not from the point-estimate siu", () => {
    const body = buildQuoteBody({ ...BASE, siu: "0.100", pattern: "cap", siuMax: "1.400" });
    expect(body.amount_usd_max).toBe("0.0676");
  });

  it("computes amount_usd_max from siu itself for a fixed pattern, which has no siu_max", () => {
    const body = buildQuoteBody({ ...BASE, siu: "1.400", pattern: "fixed" });
    expect(body.amount_usd_max).toBe("0.0676");
    expect(body.siu_max).toBeUndefined();
  });

  it("stamps schema_version", () => {
    const body = buildQuoteBody({ ...BASE, pattern: "fixed" });
    expect(body.schema_version).toBe(QUOTE_SCHEMA_VERSION);
  });

  it("carries an authorised settler when one is given", () => {
    const settler = `0x${"ab".repeat(20)}`;
    const body = buildQuoteBody({ ...BASE, pattern: "fixed", settler });
    expect(body.settler).toBe(settler);
  });

  it("omits settler entirely when none is given, rather than emitting the zero address", () => {
    const body = buildQuoteBody({ ...BASE, pattern: "fixed" });
    expect(body.settler).toBeUndefined();
    expect("settler" in body).toBe(false);
  });

  it("computes expiry as now + expiresInSeconds, RFC3339 UTC", () => {
    const body = buildQuoteBody({ ...BASE, pattern: "fixed", expiresInSeconds: 60 });
    expect(body.expiry).toBe("2026-08-15T00:01:00.000Z");
  });

  it("builds a single USDC settlement entry with amount_max in minor units", () => {
    const body = buildQuoteBody({ ...BASE, pattern: "estimate", siuMax: "1.400" });
    expect(body.settlement).toHaveLength(1);
    expect(body.settlement[0]).toEqual({
      asset: "usdc",
      chain: "base",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount_max: "67600",
    });
  });

  it("refuses to build a quote for a chain with no known USDC address", () => {
    expect(() => buildQuoteBody({ ...BASE, pattern: "fixed", chain: "ethereum" })).toThrow(
      /No known USDC address/,
    );
  });
});

describe("MINIMUM_QUOTABLE_USD", () => {
  it("is the smallest nonzero value representable at QUOTE_AMOUNT_DP's precision", () => {
    expect(MINIMUM_QUOTABLE_USD).toBe("0.0001");
  });
});
