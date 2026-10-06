import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import {
  creditNano,
  escrowFeeMinor,
  quotedPrice,
  decimalToUnits,
  fsiuValueNano,
  jobSiu,
  openingUsdcMinor,
  printNano,
  rawWorkRateUsdPerSiu,
  resultNano,
  sellerMarginNano,
  tradeRateNano,
  tradeRateUsdPerSiu,
  unitsToDecimal,
  usdcValueNano,
} from "./money.js";

// Worked by hand at an ILLUSTRATIVE print of 0.001437 USD/SIU = 1,437,000 nano-USD:
//   trade rate   1.2 x 1,437,000 = 1,724,400 nano-USD  -> "0.0017244"
//   credit       1.5 x 1,437,000 = 2,155,500 nano-USD per need (job = 1 SIU)
//   margin       1,724,400 - 1,437,000 = 287,400 nano-USD (0.2 x print)
//   opening      4,000 mSIU x 1,437,000 / 10^6 = 5,748 USDC minor units, exactly worth 4,000 mSIU
const P = 1_437_000n;

describe("decimal conversion", () => {
  it("round-trips and refuses excess precision", () => {
    expect(decimalToUnits("0.001437", 9)).toBe(1_437_000n);
    expect(unitsToDecimal(1_437_000n, 9)).toBe("0.001437");
    expect(unitsToDecimal(1_724_400n, 9)).toBe("0.0017244");
    expect(unitsToDecimal(1000n, 3)).toBe("1");
    expect(unitsToDecimal(0n, 9)).toBe("0");
    expect(unitsToDecimal(500n, 3)).toBe("0.5");
    expect(() => decimalToUnits("0.0000000001", 9)).toThrow(/more than 9/);
    expect(() => decimalToUnits("-1", 9)).toThrow(/not a non-negative/);
  });
});

describe("the lab's prices at an illustrative print", () => {
  it("prices a trade at exactly 1.2 x the print and raw work at exactly the print", () => {
    expect(printNano("0.001437")).toBe(P);
    expect(tradeRateNano(P, DEFAULT_PARAMS)).toBe(1_724_400n);
    expect(tradeRateUsdPerSiu(P, DEFAULT_PARAMS)).toBe("0.0017244");
    expect(rawWorkRateUsdPerSiu(P)).toBe("0.001437");
    expect(jobSiu(DEFAULT_PARAMS)).toBe("1");
  });

  it("credits 1.5 x the print per need and leaves the seller 0.2 x the print", () => {
    expect(creditNano(P, DEFAULT_PARAMS)).toBe(2_155_500n);
    expect(sellerMarginNano(P, DEFAULT_PARAMS)).toBe(287_400n);
    // So a need is worth more to its buyer than it costs, and a sale pays its seller: both sides gain.
    expect(creditNano(P, DEFAULT_PARAMS)).toBeGreaterThan(tradeRateNano(P, DEFAULT_PARAMS));
    expect(sellerMarginNano(P, DEFAULT_PARAMS)).toBeGreaterThan(0n);
  });

  it("opens each trader with USDC and fSIU of equal value", () => {
    expect(openingUsdcMinor(P, DEFAULT_PARAMS)).toBe(2_874n);
    expect(usdcValueNano(2_874n)).toBe(fsiuValueNano(2000n, P));
  });

  it("rounds opening USDC UP when the print does not divide evenly, so USDC is never worth less", () => {
    const odd = 1_437_001n;
    const usdc = openingUsdcMinor(odd, DEFAULT_PARAMS);
    expect(usdcValueNano(usdc)).toBeGreaterThanOrEqual(fsiuValueNano(2000n, odd));
    expect(usdcValueNano(usdc - 1n)).toBeLessThan(fsiuValueNano(2000n, odd));
  });
});

describe("resultNano — USDC plus fSIU at the print plus the credit", () => {
  it("counts the two assets the same, so converting between them changes nothing", () => {
    const asDollars = resultNano({ usdcMinor: 5_748n, fsiuMilliSiu: 0n, needsMet: 0 }, P, DEFAULT_PARAMS);
    const asClaims = resultNano({ usdcMinor: 0n, fsiuMilliSiu: 4000n, needsMet: 0 }, P, DEFAULT_PARAMS);
    expect(asDollars).toBe(asClaims);
    const half = resultNano({ usdcMinor: 2_874n, fsiuMilliSiu: 2000n, needsMet: 0 }, P, DEFAULT_PARAMS);
    expect(half).toBe(asDollars);
  });

  it("adds the credit for each need met and nothing for a need unmet", () => {
    const base = { usdcMinor: 5_748n, fsiuMilliSiu: 4000n, needsMet: 0 };
    expect(resultNano({ ...base, needsMet: 2 }, P, DEFAULT_PARAMS) - resultNano(base, P, DEFAULT_PARAMS)).toBe(4_311_000n);
  });

  it("values fSIU at the print in force, so a move in the print moves the result", () => {
    const h = { usdcMinor: 0n, fsiuMilliSiu: 4000n, needsMet: 0 };
    expect(resultNano(h, 2_000_000n, DEFAULT_PARAMS)).toBe(8_000_000n);
  });
});

describe("escrowFeeMinor — the escrow's own rule", () => {
  it("is the proportional fee rounded down", () => {
    expect(escrowFeeMinor(1_725n, 50)).toBe(8n); // 8.625
    expect(escrowFeeMinor(1_437n, 50)).toBe(7n); // 7.185
    expect(escrowFeeMinor(20_000n, 50)).toBe(100n);
  });

  it("is never below one unit on a settlement that has a fee, as the contract floors it", () => {
    expect(escrowFeeMinor(100n, 50)).toBe(1n); // 0.5 rounds to 0, floored to 1
    expect(escrowFeeMinor(199n, 50)).toBe(1n);
  });

  it("is nothing on a zero settlement or a zero fee", () => {
    expect(escrowFeeMinor(0n, 50)).toBe(0n);
    expect(escrowFeeMinor(1_725n, 0)).toBe(0n);
  });
});

describe("quotedPrice — what a quote actually carries", () => {
  // The quote format rounds the amount half-up to four decimals. Worked by hand at the illustrative print:
  //   1 SIU at 0.0017244 = 0.0017244 -> 0.0017 (1,700 minor units)
  //   1 SIU at 0.001437  = 0.001437  -> 0.0014 (1,400 minor units)
  it("is the amount rounded half-up to four decimals, as the quote format has it", () => {
    expect(quotedPrice("1", tradeRateUsdPerSiu(P, DEFAULT_PARAMS))).toEqual({ usd: "0.0017", minorUnits: 1_700n });
    expect(quotedPrice("1", rawWorkRateUsdPerSiu(P))).toEqual({ usd: "0.0014", minorUnits: 1_400n });
  });

  it("rounds a half UP, not down or to even", () => {
    expect(quotedPrice("1", "0.00175").usd).toBe("0.0018");
    expect(quotedPrice("1", "0.00165").usd).toBe("0.0017");
  });

  it("leaves a seller a positive margin on a one-SIU job even after the rounding", () => {
    const sale = quotedPrice("1", tradeRateUsdPerSiu(P, DEFAULT_PARAMS)).minorUnits;
    const unit = quotedPrice("1", rawWorkRateUsdPerSiu(P)).minorUnits;
    expect(sale - unit).toBe(300n);
  });
});
