import { describe, expect, it } from "vitest";
import {
  printDateToUnixDay,
  seriesForPrint,
  SERIES_COMMODITY,
  SERIES_FRONTIER,
  usdPerSiuToNanoUsdPerSiu,
} from "./rate-attestation.js";

describe("SERIES_FRONTIER / SERIES_COMMODITY", () => {
  it("are distinct, fixed bytes32 values matching WorkClaim.sol's own keccak256(\"frontier\")/keccak256(\"commodity\") — cross-checked against a real deployed contract's own SERIES_COMMODITY() return in WorkClaim.t.sol's trace output", () => {
    expect(SERIES_FRONTIER).toBe("0x6a33dd97c27182e82445945d5176f9e8f757598cf3cdc2b0d74eee7238b4c63b");
    expect(SERIES_COMMODITY).toBe("0x28b9bd511509601dd60a2359acd77ace0051da8b8fd3a5d60e5ce73794ae0f82");
    expect(SERIES_FRONTIER).not.toBe(SERIES_COMMODITY);
  });
});

describe("seriesForPrint", () => {
  it("maps a frontier print to SERIES_FRONTIER", () => {
    expect(seriesForPrint("frontier")).toBe(SERIES_FRONTIER);
  });

  it("maps a commodity print to SERIES_COMMODITY", () => {
    expect(seriesForPrint("commodity")).toBe(SERIES_COMMODITY);
  });

  it("throws for a blended print (series absent) — a blended print backs no WorkClaim", () => {
    expect(() => seriesForPrint(undefined)).toThrow(/no series/);
  });
});

describe("printDateToUnixDay", () => {
  it("returns 00:00:00 UTC of the given calendar date", () => {
    expect(printDateToUnixDay("2026-09-27")).toBe(BigInt(Date.UTC(2026, 8, 27) / 1000));
  });

  it("differs by exactly one day between consecutive dates", () => {
    const day1 = printDateToUnixDay("2026-09-26");
    const day2 = printDateToUnixDay("2026-09-27");
    expect(day2 - day1).toBe(86_400n);
  });
});

describe("usdPerSiuToNanoUsdPerSiu", () => {
  it("converts a real print's own dated_siu exactly, no float drift", () => {
    expect(usdPerSiuToNanoUsdPerSiu("0.001433")).toBe(1_433_000n);
  });

  it("matches WorkClaim.t.sol's own real fixture rate exactly (0.0107 -> 10_700_000)", () => {
    expect(usdPerSiuToNanoUsdPerSiu("0.0107")).toBe(10_700_000n);
  });

  it("handles a whole-number USD value with no fractional part", () => {
    expect(usdPerSiuToNanoUsdPerSiu("2")).toBe(2_000_000_000n);
  });

  it("handles a value with more than 9 fractional digits by truncating, not rounding", () => {
    expect(usdPerSiuToNanoUsdPerSiu("0.0000000009999")).toBe(0n);
  });
});
