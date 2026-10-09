import { describe, expect, it } from "vitest";
import { CATEGORY_LABELS, REASON_CATEGORIES, amendedCodes, amendmentFingerprint, cites, codeReason, readBalance, rulesFingerprint, type ReasonCategory } from "./reason-codes.js";

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

describe("reasons that only get things moving are category 9 under the frozen rules (practice round, D65)", () => {
  it("codes the practice round's sequencing reasons as no asset reason", () => {
    const p1 = "I need TYPE-2 from TRADER-3 (round 1 need). I also need to deliver the TYPE-3 job for TRADER-1 (qr-1), which requires raw work. Requesting TYPE-2 now opens the supply chain that will eventually let me acquire raw work to fulfill my delivery obligation.";
    const p8 = "I need TYPE-2 from TRADER-3 (round 1 need, now available in round 2). I also hold a paid job qr-1 that I must deliver, requiring raw work. Buying TYPE-2 now and then raw work will allow me to fulfill my obligation and meet one of my two needs.";
    expect(codeReason(p1)).toEqual(["no_asset_reason"]);
    expect(codeReason(p8)).toEqual(["no_asset_reason"]);
  });
});

describe("the balance-size amendment (D65)", () => {
  const p3 = "I owe delivery of a TYPE-3 job (qr-2 to TRADER-1) but hold no raw work units. I must buy one unit from ISSUER-B to fulfill this obligation. I have sufficient USDC (6,639 minor units) to cover the ~1.653 USD cost.";
  const p4 = "I need TYPE-2 from TRADER-3 (round 1 need, now available in round 2). I have sufficient fSIU (4,400 mSIU) to pay the 1,200 mSIU cost. Buying this fulfills my first need.";
  const relative = "I hold more fSIU than USDC in value terms, so I spend the larger holding.";

  it("reads 'I have enough' as affordability and not as a relative amount", () => {
    for (const text of [p3, p4, "I have enough USDC to pay.", "Settle with the claim; I can afford it."]) {
      expect(readBalance(text)).toEqual({ affordability: true, relative: false });
    }
  });

  it("reads a comparison of what is held, or a plentiful or scarce asset, as relative", () => {
    for (const text of [relative, "I have far more fSIU than I need, so I use it.", "USDC is running low, so I pay in fSIU.", "Most of my wallet is fSIU.", "I have plenty of fSIU, so spend it."]) {
      expect(readBalance(text).relative).toBe(true);
    }
  });

  it("leaves the frozen coding alone and changes only category 3", () => {
    expect(codeReason(p3)).toEqual(["balance_size"]);
    expect(amendedCodes(p3)).toEqual(["no_asset_reason"]);
    expect(amendedCodes(p4)).toEqual(["no_asset_reason"]);
    expect(codeReason(relative)).toEqual(["balance_size"]);
    expect(amendedCodes(relative)).toEqual(["balance_size"]);
    expect(amendedCodes("Paying in USDC preserves my fSIU for later needs, and I have enough USDC.")).toEqual(["earmarking"]);
    expect(amendedCodes("USDC is running low, so I preserve it for raw work.")).toEqual(["earmarking", "balance_size"]);
    expect(amendedCodes(undefined)).toEqual([]);
  });

  it("pins the amendment's own fingerprint, apart from the frozen rules'", () => {
    expect(amendmentFingerprint()).toBe("550b16cbba385e9775cdc5544adbb79adbba41bf6379c9fbdaaa9a3af4c2460f");
    expect(amendmentFingerprint()).not.toBe(rulesFingerprint());
  });
});

