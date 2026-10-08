import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "./economy.js";
import { reachablePrints } from "./prints.js";
import {
  creditNano,
  decimalToUnits,
  fsiuValueNano,
  jobSiu,
  legacyClaimAt,
  milliSiuAsUsdcMinor,
  openingMilliSiuPerTrader,
  openingUsdcMinor,
  priceMilliSiu,
  priceSiu,
  printNano,
  printRate,
  quotedPrice,
  quoteTerms,
  resultNano,
  sellerMarginNano,
  tradeRateNano,
  unitsToDecimal,
  usdcMinorAsMilliSiu,
  usdcNeededPerTrader,
  usdcValueNano,
} from "./money.js";

// Worked by hand at an ILLUSTRATIVE print of 0.001437 USD/SIU = 1,437,000 nano-USD (instrument v8, D50):
//   a job is priced at 1.2 SIU:  1.2 x 0.001437 = 0.0017244 USD, at six decimals rounded up 0.001725 (1,725 USDC minor units)
//   a unit of raw work at 1 SIU: 1 x 0.001437 = 0.001437 USD (1,437 minor units), exact
//   credit       1.5 x 1,437,000 = 2,155,500 nano-USD per need (job = 1 SIU)
//   margin       trade rate 1,724,400 - print 1,437,000 = 287,400 nano-USD (0.2 x print)
//   opening      2 x (1,200 + 1,000) = 4,400 mSIU of fSIU, at every print
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

describe("a quote is priced in SIU (D50)", () => {
  it("prices a job at 1.2 SIU and a unit of raw work at 1 SIU, in mSIU and as the decimal a request names", () => {
    expect(priceMilliSiu("trade", DEFAULT_PARAMS)).toBe(1_200n);
    expect(priceMilliSiu("rawwork", DEFAULT_PARAMS)).toBe(1_000n);
    expect(priceSiu("trade", DEFAULT_PARAMS)).toBe("1.2");
    expect(priceSiu("rawwork", DEFAULT_PARAMS)).toBe("1");
    expect(jobSiu(DEFAULT_PARAMS)).toBe("1");
  });

  it("rounds a price UP when the multiple does not divide the size, so a quote never asks for less than it says", () => {
    expect(priceMilliSiu("trade", { ...DEFAULT_PARAMS, tradeMultiplierBps: 12_345 })).toBe(1_235n);
    expect(priceMilliSiu("trade", { ...DEFAULT_PARAMS, tradeMultiplierBps: 12_000, jobMilliSiu: 1_001 })).toBe(1_202n);
  });

  it("names the print as every quote's rate", () => {
    expect(printNano("0.001437")).toBe(P);
    expect(printRate(P)).toBe("0.001437");
    expect(printRate(1_652_550n)).toBe("0.00165255");
  });

  it("states a quote's whole terms at a print: its price in SIU, the rate, the dollars at six decimals rounded up, and the claim", () => {
    expect(quoteTerms("trade", P, DEFAULT_PARAMS)).toEqual({ siu: "1.2", milliSiu: 1_200n, rate: "0.001437", usd: "0.001725", minorUnits: 1_725n });
    expect(quoteTerms("rawwork", P, DEFAULT_PARAMS)).toEqual({ siu: "1", milliSiu: 1_000n, rate: "0.001437", usd: "0.001437", minorUnits: 1_437n });
  });

  it("keeps the price in mSIU the same at every print while the dollars follow it", () => {
    const prints = reachablePrints(P, DEFAULT_PARAMS);
    for (const q of prints) {
      expect(quoteTerms("trade", q, DEFAULT_PARAMS).milliSiu).toBe(1_200n);
      expect(quoteTerms("rawwork", q, DEFAULT_PARAMS).milliSiu).toBe(1_000n);
    }
    const dollars = prints.map((q) => quoteTerms("trade", q, DEFAULT_PARAMS).minorUnits);
    expect(dollars).toEqual([...dollars].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(dollars[0]).toBeLessThan(dollars.at(-1)!);
  });

  it("owes the dollars its SIU price comes to, never less: the round-up is under one minor unit", () => {
    for (const q of reachablePrints(P, DEFAULT_PARAMS)) {
      for (const kind of ["trade", "rawwork"] as const) {
        const t = quoteTerms(kind, q, DEFAULT_PARAMS);
        const exactNano = t.milliSiu * q; // mSIU x nano-USD per SIU = 1e-12 USD
        const owedNano = t.minorUnits * 1_000_000n; // minor units = 1e-6 USD
        expect(owedNano).toBeGreaterThanOrEqual(exactNano);
        expect(owedNano - exactNano).toBeLessThan(1_000_000n);
      }
    }
  });
});

describe("the lab's other prices at an illustrative print", () => {
  it("credits 1.5 x the print per need and leaves the seller 0.2 x the print", () => {
    expect(tradeRateNano(P, DEFAULT_PARAMS)).toBe(1_724_400n);
    expect(creditNano(P, DEFAULT_PARAMS)).toBe(2_155_500n);
    expect(sellerMarginNano(P, DEFAULT_PARAMS)).toBe(287_400n);
    // So a need is worth more to its buyer than it costs, and a sale pays its seller: both sides gain.
    expect(creditNano(P, DEFAULT_PARAMS)).toBeGreaterThan(tradeRateNano(P, DEFAULT_PARAMS));
    expect(sellerMarginNano(P, DEFAULT_PARAMS)).toBeGreaterThan(0n);
  });
});

describe("the opening follows the schedule and the prices (D31, D50)", () => {
  it("gives each trader exactly what its quotes come to in claims: two jobs and two units of raw work", () => {
    expect(openingMilliSiuPerTrader(DEFAULT_PARAMS)).toBe(4_400n);
    expect(openingMilliSiuPerTrader({ ...DEFAULT_PARAMS, needsPerTrader: 1 })).toBe(2_200n);
  });

  it("sizes USDC so it alone pays every quote, which is a minor unit or two more than the fSIU's value at the same print", () => {
    // At the illustrative print the fSIU is worth 4,400 x 1.437 = 6,322.8 minor units, so 6,323 rounded up; the four quotes cost
    // 2 x (1,725 + 1,437) = 6,324, because each one's dollars round up. USDC covers the larger.
    expect(usdcNeededPerTrader([P], DEFAULT_PARAMS)).toBe(6_324n);
    expect(openingUsdcMinor([P], DEFAULT_PARAMS)).toBe(6_324n);
    expect(usdcValueNano(6_324n)).toBeGreaterThanOrEqual(fsiuValueNano(4_400n, P));
  });

  it("keeps either asset alone enough at other prints, not only the illustrative one", () => {
    for (const print of [900_000n, 1_000_000n, 1_437_001n, 2_500_000n, 7_777_777n]) {
      const usdc = openingUsdcMinor([print], DEFAULT_PARAMS);
      expect(usdc).toBeGreaterThanOrEqual(usdcNeededPerTrader([print], DEFAULT_PARAMS));
      expect(usdcValueNano(usdc)).toBeGreaterThanOrEqual(fsiuValueNano(openingMilliSiuPerTrader(DEFAULT_PARAMS), print));
    }
  });

  describe("when the print moves (D41): USDC sized at the highest print the walk can reach", () => {
    const reachable = reachablePrints(P, DEFAULT_PARAMS);
    const ceiling = reachable.at(-1)!;

    it("reaches a highest print of 1,900,432 nano-USD per SIU from 1,437,000 in three rounds of 15%", () => {
      expect(ceiling).toBe(1_900_432n);
    });

    it("sizes USDC at the ceiling: 8,364 minor units against 8,362 for the fSIU's value there, since each quote rounds up", () => {
      expect(usdcNeededPerTrader(reachable, DEFAULT_PARAMS)).toBe(8_364n);
      expect(openingUsdcMinor(reachable, DEFAULT_PARAMS)).toBe(8_364n);
      expect(usdcValueNano(8_362n)).toBeGreaterThanOrEqual(fsiuValueNano(4_400n, ceiling));
      expect(usdcValueNano(8_361n)).toBeLessThan(fsiuValueNano(4_400n, ceiling));
    });

    it("covers every quote at every print the walk can reach, in USDC alone", () => {
      const usdc = openingUsdcMinor(reachable, DEFAULT_PARAMS);
      for (const q of reachable) {
        const needs = BigInt(DEFAULT_PARAMS.needsPerTrader) * (quoteTerms("trade", q, DEFAULT_PARAMS).minorUnits + quoteTerms("rawwork", q, DEFAULT_PARAMS).minorUnits);
        expect(usdc, `at ${q}`).toBeGreaterThanOrEqual(needs);
      }
    });

    it("says USDC is worth more than the fSIU at round 1's print: the price of guaranteeing USDC alone is enough at the ceiling", () => {
      expect(usdcValueNano(openingUsdcMinor(reachable, DEFAULT_PARAMS))).toBeGreaterThan(fsiuValueNano(openingMilliSiuPerTrader(DEFAULT_PARAMS), P));
    });

    it("with a fixed print (no step) sizes USDC at that one print", () => {
      const fixed = reachablePrints(P, { ...DEFAULT_PARAMS, printStepBps: 0 });
      expect(fixed).toEqual([P]);
      expect(openingUsdcMinor(fixed, DEFAULT_PARAMS)).toBe(6_324n);
    });
  });
});

describe("a holding in the other asset's terms (the holdings line)", () => {
  it("converts at the print in force, to the nearest unit", () => {
    // 8,364 USDC minor units at 1.437 USD/SIU = 5,820.46 mSIU; 4,400 mSIU at 1.437 = 6,322.8 minor units.
    expect(usdcMinorAsMilliSiu(8_364n, P)).toBe(5_820n);
    expect(milliSiuAsUsdcMinor(4_400n, P)).toBe(6_323n);
    expect(usdcMinorAsMilliSiu(0n, P)).toBe(0n);
    expect(milliSiuAsUsdcMinor(0n, P)).toBe(0n);
  });

  it("rounds a half up", () => {
    // 1,000 mSIU at 0.0015 USD/SIU (1,500,000 nano) is exactly 1,500 minor units; 1 mSIU at 1,500,000 nano is 1.5 -> 2.
    expect(milliSiuAsUsdcMinor(1_000n, 1_500_000n)).toBe(1_500n);
    expect(milliSiuAsUsdcMinor(1n, 1_500_000n)).toBe(2n);
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
  it("is the amount at USDC's six decimals, rounded up, which is the SDK's own product and not a re-derivation", () => {
    expect(quotedPrice("1.2", "0.001437")).toEqual({ usd: "0.001725", minorUnits: 1_725n });
    expect(quotedPrice("1", "0.001437")).toEqual({ usd: "0.001437", minorUnits: 1_437n });
  });

  it("rounds UP, never half-up or down", () => {
    expect(quotedPrice("1", "0.0000011")).toEqual({ usd: "0.000002", minorUnits: 2n });
    expect(quotedPrice("1", "0.0000019")).toEqual({ usd: "0.000002", minorUnits: 2n });
    expect(quotedPrice("1", "0.000002")).toEqual({ usd: "0.000002", minorUnits: 2n });
  });

  it("leaves a seller a positive margin on a job even after the rounding", () => {
    const sale = quoteTerms("trade", P, DEFAULT_PARAMS).minorUnits;
    const unit = quoteTerms("rawwork", P, DEFAULT_PARAMS).minorUnits;
    expect(sale - unit).toBe(288n);
  });
});

describe("legacyClaimAt — a claim as versions before 8 sized it, for reading their reports", () => {
  it("is the quote's dollars at four decimals, half-up, sized at the print and rounded up", () => {
    // A job's quote was 1,700 minor units and a unit's 1,400; their claims 1,184 and 975 mSIU at this print.
    expect(legacyClaimAt("trade", P, DEFAULT_PARAMS)).toBe(1_184n);
    expect(legacyClaimAt("rawwork", P, DEFAULT_PARAMS)).toBe(975n);
  });
});
