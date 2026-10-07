import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { reachablePrints } from "./prints.js";
import {
  creditNano,
  jobClaimAt,
  quotedPrice,
  decimalToUnits,
  fsiuValueNano,
  jobSiu,
  openingMilliSiuPerTrader,
  openingUsdcMinor,
  printNano,
  rawClaimAt,
  rawWorkRateUsdPerSiu,
  resultNano,
  sellerMarginNano,
  tradeRateNano,
  tradeRateUsdPerSiu,
  unitsToDecimal,
  usdcNeededPerTrader,
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

  it("sizes the opening from the print and the schedule: each trader buys two jobs and two units of raw work (D31)", () => {
    // A job's quote is 1,700 minor units and a unit's 1,400; the claim for each is its price's worth at the print, rounded
    // up: 1,184 and 975 mSIU. Each trader buys two jobs and, selling two, two units: 2 x (1,184 + 975).
    expect(openingMilliSiuPerTrader([P], DEFAULT_PARAMS)).toBe(4_318n);
    expect(usdcNeededPerTrader([P], DEFAULT_PARAMS)).toBe(6_200n);
  });

  it("opens each trader with USDC and fSIU of equal value, either alone enough for every quote", () => {
    expect(openingUsdcMinor([P], DEFAULT_PARAMS)).toBe(6_205n);
    // 6,205 USDC minor units against 4,318 mSIU at the print: the fSIU is worth 6,204.966 of them, so the USDC is the
    // same value rounded up, never less.
    expect(usdcValueNano(6_205n)).toBeGreaterThanOrEqual(fsiuValueNano(4_318n, P));
    expect(usdcValueNano(6_205n) - fsiuValueNano(4_318n, P)).toBeLessThan(1_000n);
    expect(openingUsdcMinor([P], DEFAULT_PARAMS)).toBeGreaterThanOrEqual(usdcNeededPerTrader([P], DEFAULT_PARAMS));
  });

  it("rounds opening USDC UP when the print does not divide evenly, so USDC is never worth less", () => {
    const odd = 1_437_001n;
    const fsiu = openingMilliSiuPerTrader([odd], DEFAULT_PARAMS);
    const usdc = openingUsdcMinor([odd], DEFAULT_PARAMS);
    expect(usdcValueNano(usdc)).toBeGreaterThanOrEqual(fsiuValueNano(fsiu, odd));
    expect(usdcValueNano(usdc - 1n)).toBeLessThan(fsiuValueNano(fsiu, odd));
  });

  it("keeps either asset alone enough at other prints, not only the illustrative one", () => {
    for (const print of [900_000n, 1_000_000n, 1_437_001n, 2_500_000n, 7_777_777n]) {
      expect(openingUsdcMinor([print], DEFAULT_PARAMS)).toBeGreaterThanOrEqual(usdcNeededPerTrader([print], DEFAULT_PARAMS));
    }
  });

  describe("when the print moves (D41): sized at the highest print the walk can reach", () => {
    const reachable = reachablePrints(P, DEFAULT_PARAMS);

    it("asks for about the same fSIU at every print, because a quote's price follows the print", () => {
      // A job's claim is about 1.2 SIU and a unit of raw work's about 1 SIU whatever the print: only the quote's $0.0001 rounding moves it.
      for (const q of reachable) {
        expect(jobClaimAt(q, DEFAULT_PARAMS)).toBeGreaterThanOrEqual(1_150n);
        expect(jobClaimAt(q, DEFAULT_PARAMS)).toBeLessThanOrEqual(1_250n);
        expect(rawClaimAt(q, DEFAULT_PARAMS)).toBeGreaterThanOrEqual(950n);
        expect(rawClaimAt(q, DEFAULT_PARAMS)).toBeLessThanOrEqual(1_050n);
      }
    });

    it("takes the largest claim any reachable print asks for, so fSIU alone is enough on every path", () => {
      const fsiu = openingMilliSiuPerTrader(reachable, DEFAULT_PARAMS);
      for (const q of reachable) expect(fsiu).toBeGreaterThanOrEqual(2n * (jobClaimAt(q, DEFAULT_PARAMS) + rawClaimAt(q, DEFAULT_PARAMS)));
    });

    it("sizes USDC at the ceiling, so USDC alone is enough on every path, and says it is worth more than the fSIU at round 1", () => {
      const ceiling = reachable.at(-1)!;
      const usdc = openingUsdcMinor(reachable, DEFAULT_PARAMS);
      expect(usdc).toBeGreaterThanOrEqual(usdcNeededPerTrader(reachable, DEFAULT_PARAMS));
      // The needs at every lower print are cheaper in dollars, so the ceiling's cover them all.
      for (const q of reachable) {
        const needs = BigInt(DEFAULT_PARAMS.needsPerTrader) * (quotedPrice("1", tradeRateUsdPerSiu(q, DEFAULT_PARAMS)).minorUnits + quotedPrice("1", rawWorkRateUsdPerSiu(q)).minorUnits);
        expect(usdc, `at ${q}`).toBeGreaterThanOrEqual(needs);
      }
      // At round 1's print the USDC is worth more than the fSIU: the price of guaranteeing USDC alone is enough at the ceiling.
      expect(usdcValueNano(usdc)).toBeGreaterThan(fsiuValueNano(openingMilliSiuPerTrader(reachable, DEFAULT_PARAMS), P));
      expect(usdcValueNano(usdc)).toBeGreaterThanOrEqual(fsiuValueNano(openingMilliSiuPerTrader(reachable, DEFAULT_PARAMS), ceiling));
    });

    it("with a fixed print (no step) is v4's figure exactly", () => {
      const fixed = reachablePrints(P, { ...DEFAULT_PARAMS, printStepBps: 0 });
      expect(fixed).toEqual([P]);
      expect(openingMilliSiuPerTrader(fixed, DEFAULT_PARAMS)).toBe(4_318n);
      expect(openingUsdcMinor(fixed, DEFAULT_PARAMS)).toBe(6_205n);
    });
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
