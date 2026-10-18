/**
 * The research scheme and its rules. The passages below are ILLUSTRATIVE: written for these tests, not agent output, and the rules were not tuned on any real reasoning (none exists yet).
 */
import { describe, expect, it } from "vitest";
import {
  RESEARCH_CATEGORY_IDS,
  RESEARCH_TRIGGER_WORDS,
  codeResearch,
  researchPatternSources,
  researchRulesFingerprint,
} from "./research-codes.js";
import { PAYMENT_SCHEME, RESEARCH_SCHEME, applyChoice, isAnswered } from "./schemes.js";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const wholeWord = (word: string, text: string): boolean => {
  const stem = word.endsWith("*");
  const w = (stem ? word.slice(0, -1) : word).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${w}${stem ? "" : "(?![a-z0-9])"}`, "i").test(text);
};

describe("the research scheme", () => {
  it("is the owner's draft plus the two additions, 'none' last, with unique ids", () => {
    expect(RESEARCH_CATEGORY_IDS).toEqual([
      "discovery",
      "finding_entity_id",
      "choosing_window",
      "choosing_fields",
      "checking_completeness",
      "planning_arithmetic",
      "handling_units_scale",
      "recovering_from_errors",
      "giving_up_or_filling_in",
      "restraining_cost",
      "none",
    ]);
    expect(new Set(RESEARCH_CATEGORY_IDS).size).toBe(RESEARCH_CATEGORY_IDS.length);
  });

  it("describes each category by what it is about, using none of the rules' trigger words", () => {
    for (const c of RESEARCH_SCHEME.categories) {
      const words = RESEARCH_TRIGGER_WORDS[c.id as keyof typeof RESEARCH_TRIGGER_WORDS] ?? [];
      for (const w of Object.values(RESEARCH_TRIGGER_WORDS).flat())
        expect(wholeWord(w, c.meaning), `"${w}" in the description of ${c.id}`).toBe(false);
      expect(Array.isArray(words)).toBe(true);
    }
  });

  it("lists only trigger words that are really in that category's patterns", () => {
    for (const [cat, words] of Object.entries(RESEARCH_TRIGGER_WORDS)) {
      const sources = researchPatternSources(cat as keyof typeof RESEARCH_TRIGGER_WORDS)
        .map(norm)
        .join("|");
      // each word of a phrase must be in the category's patterns ("too big" is two alternatives of one pattern, so the phrase itself is not a substring)
      for (const w of words)
        for (const part of w.replace("*", "").split(/[\s-]+/))
          expect(sources, `${cat}: "${w}"`).toContain(norm(part));
    }
  });
});

describe("the research rules", () => {
  const cases: [string, string, string[]][] = [
    [
      "discovery",
      "I'll start by listing the catalog to see what datasets are available.",
      ["discovery"],
    ],
    [
      "finding_entity_id",
      "I need the exact slug for Hyperliquid before I can request it.",
      ["finding_entity_id"],
    ],
    [
      "choosing_window",
      "The end date is exclusive, so I should ask for the first of the next month.",
      ["choosing_window"],
    ],
    [
      "choosing_fields",
      "I only need the volume metric, so I'll pass selections for just that.",
      ["choosing_fields"],
    ],
    [
      "checking_completeness",
      "Before answering I should check that I have every venue; a page may be missing.",
      ["checking_completeness"],
    ],
    [
      "planning_arithmetic",
      "Then I'll sum each month and divide by the combined total to get the share.",
      ["planning_arithmetic"],
    ],
    [
      "handling_units_scale",
      "These look like minor units and the magnitude is off by a thousandfold.",
      ["handling_units_scale"],
    ],
    [
      "recovering_from_errors",
      "The call failed with a 429, so I will wait and retry.",
      ["recovering_from_errors"],
    ],
    [
      "giving_up_or_filling_in",
      "I can't find the data for that chain, so I'll use a placeholder.",
      ["giving_up_or_filling_in"],
    ],
    [
      "restraining_cost",
      "That response would be too large, so I will request fewer series per call.",
      ["restraining_cost"],
    ],
  ];
  it.each(cases)("codes %s", (_cat, text, expected) => {
    expect(codeResearch(text)).toEqual(expected);
  });

  it("carries several codes when a passage is about several things, in category order", () => {
    expect(
      codeResearch(
        "The search came back empty, so rather than guess I will list the catalog again.",
      ),
    ).toEqual(["discovery", "recovering_from_errors", "giving_up_or_filling_in"]);
  });

  it("codes a passage that fires nothing as none, and an empty one as nothing at all", () => {
    expect(codeResearch("The question asks for the top five venues.")).toEqual(["none"]);
    expect(codeResearch("")).toEqual([]);
    expect(codeResearch("   ")).toEqual([]);
    expect(codeResearch(undefined)).toEqual([]);
  });

  it("reads curly quotes as straight ones", () => {
    expect(codeResearch("I can’t find it, so I’ll use a placeholder.")).toContain(
      "giving_up_or_filling_in",
    );
  });

  it("is frozen: the rules' fingerprint is the one recorded before any agent reasoning existed", () => {
    // Changing a pattern changes this value. That must be a deliberate, recorded decision (a new revision of the rules, with the date), never a quiet edit.
    expect(researchRulesFingerprint()).toBe(
      "ac548a662f6343ad492cb1dc5d945df82fd301c8924945d32bed5284865020a0",
    );
  });
});

describe("what may be ticked together", () => {
  const research = RESEARCH_SCHEME;
  const payment = PAYMENT_SCHEME;
  const cat = (id: string, on: boolean) => ({ kind: "cat" as const, id, on });

  it("research: 'none' clears everything and is cleared by any other box", () => {
    // `state` is the boxes as they stand AFTER the click, as the page passes it
    const first = applyChoice(
      research,
      { ids: ["discovery"], flag: false },
      cat("discovery", true),
    );
    expect(first.ids).toEqual(["discovery"]);
    let s = applyChoice(
      research,
      { ids: ["discovery", "restraining_cost"], flag: false },
      cat("restraining_cost", true),
    );
    expect(s.ids).toEqual(["discovery", "restraining_cost"]);
    s = applyChoice(research, { ids: [...s.ids, "none"], flag: false }, cat("none", true));
    expect(s.ids).toEqual(["none"]);
    s = applyChoice(research, { ids: ["none", "discovery"], flag: false }, cat("discovery", true));
    expect(s.ids).toEqual(["discovery"]);
  });

  it("payment: 'no asset reason' stands alone, which prevents the earmarking-and-no-asset clash of D69", () => {
    const s = applyChoice(
      payment,
      { ids: ["earmarking", "keeping_options_open", "no_asset_reason"], flag: true },
      cat("no_asset_reason", true),
    );
    expect(s).toEqual({ ids: ["no_asset_reason"], flag: false });
    const t = applyChoice(
      payment,
      { ids: ["no_asset_reason", "earmarking"], flag: false },
      cat("earmarking", true),
    );
    expect(t.ids).toEqual(["earmarking"]);
  });

  it("payment: the affordability flag stands beside categories 1 to 8, and clears the exclusive ones", () => {
    const a = applyChoice(
      payment,
      { ids: ["balance_size"], flag: true },
      { kind: "flag", on: true },
    );
    expect(a).toEqual({ ids: ["balance_size"], flag: true });
    const b = applyChoice(
      payment,
      { ids: ["no_asset_reason"], flag: true },
      { kind: "flag", on: true },
    );
    expect(b).toEqual({ ids: [], flag: true });
    const c = applyChoice(payment, { ids: ["earmarking"], flag: true }, cat("none", true));
    expect(c).toEqual({ ids: ["none"], flag: false });
  });

  it("unticking changes nothing else", () => {
    expect(applyChoice(payment, { ids: ["earmarking"], flag: true }, cat("expiry", false))).toEqual(
      { ids: ["earmarking"], flag: true },
    );
  });

  it("a passage is answered by any box, the flag included, and not by none", () => {
    expect(isAnswered({ ids: [], flag: true })).toBe(true);
    expect(isAnswered({ ids: ["none"], flag: false })).toBe(true);
    expect(isAnswered({ ids: [], flag: false })).toBe(false);
    expect(isAnswered(undefined)).toBe(false);
  });

  it("the payment scheme keeps the lab's nine categories, in the lab's order, plus none", () => {
    expect(payment.categories.map((c) => c.id)).toEqual([
      "earmarking",
      "price_direction",
      "balance_size",
      "familiarity",
      "following_brief",
      "keeping_options_open",
      "expiry",
      "cost_efficiency",
      "no_asset_reason",
      "none",
    ]);
    expect(payment.flag?.name).toBe("Mentions affordability");
  });
});
