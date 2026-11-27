import { describe, expect, it } from "vitest";
import type { Print } from "@touchstone/sdk";
import { printBodyHashHex } from "./sign/canonicalise.js";
import {
  PAID_TOOL_PRICES_USD,
  SIU_PRICE_MAX_AGE_DAYS,
  commodityPrintCandidates,
  priceLabel,
  siuPriceFor,
} from "./siu-price.js";

describe("priceLabel", () => {
  it("states the USD price, and the mSIU figure with its print date when there is one", () => {
    const siu = siuPriceFor(
      "0.001",
      {
        version: "SIU-2026a",
        print_id: "2026-11-26-commodity",
        date: "2026-11-26",
        series: "commodity",
        dated_siu: "0.001409",
        methodology_version: "v0-draft",
      } as unknown as Print,
      new Date("2026-11-26T12:00:00Z"),
    );
    expect(priceLabel("0.001", siu)).toBe(
      "$0.001 USDC (710 mSIU at the 2026-11-26 Commodity print)",
    );
    expect(priceLabel("0.01", undefined)).toBe("$0.01 USDC");
  });
});

// The real figures of the 2026-11-26 Commodity print, in a minimal body (the hash below is of
// this fixture, not of the published file).
const COMMODITY = {
  version: "SIU-2026a",
  print_id: "2026-11-26-commodity",
  date: "2026-11-26",
  status: "provisional",
  series: "commodity",
  dated_siu: "0.001409",
  methodology_version: "v0-draft",
  methodology_revision: "rules-2026-11-21",
} as unknown as Print;

const NOON = new Date("2026-11-26T12:00:00Z");

describe("siuPriceFor", () => {
  it("prices each paid tool in whole mSIU at the Commodity print, with the print's own identifiers", () => {
    expect(siuPriceFor(PAID_TOOL_PRICES_USD.get_quote, COMMODITY, NOON)).toEqual({
      price_msiu: "710",
      rate_usd_per_siu: "0.001409",
      grade: "commodity",
      print_id: "2026-11-26-commodity",
      print_date: "2026-11-26",
      print_hash: printBodyHashHex(COMMODITY),
      methodology_version: "v0-draft",
      methodology_revision: "rules-2026-11-21",
    });
    expect(siuPriceFor(PAID_TOOL_PRICES_USD.verify_receipt, COMMODITY, NOON)?.price_msiu).toBe(
      "7097",
    );
    expect(siuPriceFor("0.005", COMMODITY, NOON)?.price_msiu).toBe("3549");
  });

  it("rounds half-up to a whole mSIU, never half-to-even", () => {
    // 0.00001 / 0.004 x 1000 = 2.5 exactly.
    const print = { ...COMMODITY, dated_siu: "0.004" } as Print;
    expect(siuPriceFor("0.00001", print, NOON)?.price_msiu).toBe("3");
  });

  it("omits the price, never guesses, when there is no usable Commodity print", () => {
    expect(siuPriceFor("0.001", undefined, NOON)).toBeUndefined();
    const blended = { ...COMMODITY, print_id: "2026-11-26" } as Record<string, unknown>;
    delete blended.series;
    expect(siuPriceFor("0.001", blended as unknown as Print, NOON)).toBeUndefined();
    expect(
      siuPriceFor("0.001", { ...COMMODITY, series: "frontier" } as Print, NOON),
    ).toBeUndefined();
    expect(
      siuPriceFor(
        "0.001",
        {
          ...COMMODITY,
          superseded_by: { print_id: "2026-11-26b-commodity", reason: "test correction" },
        } as Print,
        NOON,
      ),
    ).toBeUndefined();
    for (const bad of ["0", "-0.001409", "abc", ""]) {
      expect(siuPriceFor("0.001", { ...COMMODITY, dated_siu: bad } as Print, NOON)).toBeUndefined();
    }
    const noMethodology = { ...COMMODITY } as Record<string, unknown>;
    delete noMethodology.methodology_version;
    expect(siuPriceFor("0.001", noMethodology as unknown as Print, NOON)).toBeUndefined();
    expect(siuPriceFor("0.001", { ...COMMODITY, date: "26 Nov" } as Print, NOON)).toBeUndefined();
  });

  it("omits the price for an unusable tool price", () => {
    for (const bad of ["0", "-0.001", "$0.001", "abc"]) {
      expect(siuPriceFor(bad, COMMODITY, NOON)).toBeUndefined();
    }
  });

  it(`follows the daily print, and omits a print older than ${SIU_PRICE_MAX_AGE_DAYS} days`, () => {
    expect(SIU_PRICE_MAX_AGE_DAYS).toBe(7);
    expect(siuPriceFor("0.001", COMMODITY, new Date("2026-12-03T23:59:59Z"))?.price_msiu).toBe(
      "710",
    );
    expect(siuPriceFor("0.001", COMMODITY, new Date("2026-12-04T00:00:00Z"))).toBeUndefined();
  });

  it("omits a price that would round to zero mSIU", () => {
    expect(siuPriceFor("0.0000001", COMMODITY, NOON)).toBeUndefined();
  });
});

describe("commodityPrintCandidates", () => {
  it("returns the newest date's Commodity prints, the latest revision first", () => {
    expect(
      commodityPrintCandidates([
        "2026-11-21b-commodity",
        "2026-11-25-commodity",
        "2026-11-26",
        "2026-11-26-frontier",
        "2026-11-26-commodity",
      ]),
    ).toEqual(["2026-11-26-commodity"]);
    expect(
      commodityPrintCandidates([
        "2026-11-26-commodity",
        "2026-11-26c-commodity",
        "2026-11-26b-commodity",
      ]),
    ).toEqual(["2026-11-26c-commodity", "2026-11-26b-commodity", "2026-11-26-commodity"]);
    expect(commodityPrintCandidates(["2026-11-26", "2026-11-26-frontier"])).toEqual([]);
  });
});
