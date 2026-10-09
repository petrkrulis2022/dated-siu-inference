import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, REASON_CATEGORIES, cites, codeReason, rulesFingerprint, type ReasonCategory } from "./reason-codes.js";

/** Reasons written for the test, each with the categories it must carry. Several are the wording of the v8 run's stated reasons. */
const CASES: readonly { text: string; codes: ReasonCategory[] }[] = [
  // earmarking
  { text: "Paying with USDC preserves my fSIU for future needs in rounds 2-3.", codes: ["earmarking"] },
  { text: "Accept the job by paying in USDC to preserve fSIU for raw work purchases needed to deliver my TYPE-4 jobs.", codes: ["earmarking"] },
  { text: "Settle with fSIU; this preserves USDC for raw work purchases.", codes: ["earmarking"] },
  { text: "Paying with my held claim leaves me with USDC for other needs.", codes: ["earmarking"] },
  { text: "Keep the fSIU in reserve.", codes: ["earmarking"] },
  { text: "Since I still must buy raw work, I keep fSIU for that and pay this quote in USDC.", codes: ["earmarking"] },
  // price direction
  { text: "The print rose 15%, so I pay in the asset that has not moved.", codes: ["price_direction"] },
  { text: "The print is falling, which makes USDC cheaper later.", codes: ["price_direction", "cost_efficiency"] },
  { text: "Given the trend in the print, I hold fSIU.", codes: ["price_direction"] },
  // balance size
  { text: "I have sufficient USDC (6,927 minor units) to pay.", codes: ["balance_size"] },
  { text: "Plenty of fSIU left, so spend it.", codes: ["balance_size"] },
  { text: "My USDC balance is low.", codes: ["balance_size"] },
  { text: "Settling the quote with remaining 1000 mSIU fSIU.", codes: ["balance_size"] },
  { text: "I hold 5,600 mSIU and the quote needs 1,200.", codes: ["balance_size"] },
  { text: "I hold more fSIU than USDC in value terms so I spend the larger holding.", codes: ["balance_size"] },
  // familiarity
  { text: "USDC is the standard, simplest way to pay.", codes: ["familiarity"] },
  { text: "Dollars are safer and familiar.", codes: ["familiarity"] },
  // following the brief
  { text: "As stated in the brief, converting changes nothing about my result.", codes: ["following_brief"] },
  { text: "The result is the same either way, so any route works.", codes: ["following_brief"] },
  { text: "Both are equivalent in value at this print, so I pick the first.", codes: ["following_brief"] },
  { text: "Per the instructions, I am never required to convert.", codes: ["following_brief"] },
  // keeping options open
  { text: "Keep flexibility by paying in fSIU.", codes: ["keeping_options_open"] },
  { text: "Paying in USDC avoids committing my claims and keeps options open.", codes: ["keeping_options_open"] },
  { text: "Split the payment to keep both assets.", codes: ["keeping_options_open"] },
  // expiry
  { text: "fSIU expires when the window closes, so spend it now.", codes: ["expiry"] },
  { text: "The claim will lapse at the close of the window.", codes: ["expiry"] },
  // cost or efficiency
  { text: "Paying in USDC costs 0.001437 USD, which is minimal.", codes: ["cost_efficiency"] },
  { text: "This is the cheapest route.", codes: ["cost_efficiency"] },
  { text: "Paying with my held claim is efficient.", codes: ["cost_efficiency"] },
  // no asset reason
  { text: "Settle the TYPE-4 quote from TRADER-1 to meet my round-1 need.", codes: ["no_asset_reason"] },
  { text: "Settle qr-9 to meet my remaining TYPE-3 need from TRADER-2.", codes: ["no_asset_reason"] },
  { text: "Settle the TYPE-1 job quote from TRADER-4 to meet my remaining open need in round 2 using USDC.", codes: ["no_asset_reason"] },
  // several at once
  {
    text: "Paying in USDC preserves my fSIU for later needs and costs less, and I have enough USDC.",
    codes: ["earmarking", "balance_size", "cost_efficiency"],
  },
];

describe("codeReason", () => {
  for (const c of CASES) {
    it(`codes: ${c.text}`, () => {
      expect(codeReason(c.text)).toEqual(c.codes);
    });
  }

  it("gives a blank or absent reason no codes at all", () => {
    expect(codeReason(undefined)).toEqual([]);
    expect(codeReason("")).toEqual([]);
    expect(codeReason("   \n")).toEqual([]);
  });

  it("returns the codes in the order of the categories, once each", () => {
    const codes = codeReason("It costs less, I have enough USDC and the print rose; preserve fSIU for future needs.");
    const sorted = [...codes].sort((a, b) => REASON_CATEGORIES.indexOf(a) - REASON_CATEGORIES.indexOf(b));
    expect(codes).toEqual(sorted);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("does not read a quote's own expiry as the fSIU expiring", () => {
    expect(codeReason("Settle now to secure the job before the quote expires.")).toEqual(["no_asset_reason"]);
    expect(codeReason("The quote's expiry is an hour away.")).toEqual(["no_asset_reason"]);
    expect(codeReason("Request with expiresInSeconds 3600 to buy my need.")).toEqual(["no_asset_reason"]);
  });

  it("reads the straightened and the curly apostrophe alike", () => {
    expect(codeReason("The quote’s expiry is an hour away.")).toEqual(codeReason("The quote's expiry is an hour away."));
  });

  it("does not read the print named without a direction as a price direction", () => {
    expect(codeReason("Settle at round 2's print (0.00165255) to meet my need.")).toEqual(["no_asset_reason"]);
  });

  it("does not read 'simple' or 'standard' as familiarity unless USDC or dollars are named", () => {
    expect(codeReason("This is a simple, standard acceptance of a valid request.")).toEqual(["no_asset_reason"]);
  });

  it("has a label for every category, and cites() agrees with codeReason()", () => {
    for (const c of REASON_CATEGORIES) expect(CATEGORY_LABELS[c].length).toBeGreaterThan(10);
    expect(cites("Preserve fSIU for raw work.", "earmarking")).toBe(true);
    expect(cites("Preserve fSIU for raw work.", "expiry")).toBe(false);
  });

  it("runs on a long thinking summary in a moment", () => {
    const long = "I consider the options. ".repeat(500);
    const t0 = Date.now();
    codeReason(long);
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

describe("rulesFingerprint", () => {
  // Frozen with the rules, before any probe data exists. Changing a rule changes this on purpose: update it only with a note in
  // docs/marketplace_plan.md §14.6 and a commit that is dated before the first stage-1 call, or the battery's results are exploratory.
  it("is the frozen one", () => {
    expect(rulesFingerprint()).toBe("6d718eb1185983e843240900a0ad936e3acb2eccf87fa34ad4a565744a4036e2");
  });
});
