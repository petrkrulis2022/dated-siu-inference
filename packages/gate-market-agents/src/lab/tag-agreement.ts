/**
 * How far the keyword rules agree with a person's tags (docs/marketplace_plan.md §14.6, D65, D68). The person ticks any of the nine categories, the extra box A
 * ("affordability only"), or "none of these", blind to the rules' output; this compares those ticks with the rules' codes for the same reasons, as counts.
 *
 * Two codings are compared and always labelled, never merged: the **frozen** rules (the primary result), under which "I have sufficient X" falls in category 3,
 * and the **amended** layer (exploratory, made after pilot replies were seen), under which it is affordability and category 3 means only a relative amount.
 * Box A is not folded into 3 or 9: it gets its own table saying where each coding put the reasons the person ticked A for.
 */
import { REASON_CATEGORIES, amendedCodes, codeReason, readBalance, type ReasonCategory } from "./reason-codes.js";

export interface TaggedReason {
  id: string;
  text: string;
  /** The categories the person ticked (never includes A or "none of these"). */
  categories: readonly ReasonCategory[];
  /**
   * Box A. Labelled "Affordability only" on the page but allowed alongside categories 1 to 8, which contradict each other; the person used it to mean "the
   * reason mentions affordability" and combined it with other categories. It is therefore analysed as an affordability FLAG, never as "only" (D69).
   */
  affordabilityOnly: boolean;
  noneOfThese: boolean;
}

export interface CategoryAgreement {
  category: ReasonCategory;
  /** The person ticked it and the rules coded it. */
  both: number;
  humanOnly: number;
  ruleOnly: number;
  neither: number;
  /** (both + neither) of all reasons, as a whole percent, rounded half up. */
  agreementPercent: number;
}

export interface CodingAgreement {
  /** "frozen (primary)" or "amended balance coding (exploratory)". */
  label: string;
  perCategory: CategoryAgreement[];
}

export interface AffordabilityMapping {
  /** Reasons the person ticked A for. */
  ticked: number;
  frozen: { label: string; inCategory3: number; inCategory9: number; inOtherCategoriesOnly: number };
  amended: { label: string; affordabilityFired: number; relativeFired: number; inCategory9: number; inCategory3: number };
  /** Reasons the person did NOT tick A for, on which the amended layer's affordability reading fires anyway. */
  notTickedButAffordabilityFired: number;
}

/** The person's A flag against the amended layer's affordability reading: a 2x2 of counts. */
export interface FlagAgreement {
  both: number;
  humanOnly: number;
  ruleOnly: number;
  neither: number;
}

export interface Clash {
  id: string;
  /** What was ticked, as recorded: the clash is reported, never corrected. */
  categories: readonly ReasonCategory[];
  affordabilityOnly: boolean;
  noneOfThese: boolean;
  why: string;
}

export interface AgreementReport {
  reasons: number;
  noneOfThese: number;
  frozen: CodingAgreement;
  amended: CodingAgreement;
  affordability: AffordabilityMapping;
  /** A read as a flag: against the amended layer's affordability reading (exploratory). */
  affordabilityFlag: FlagAgreement;
  /** Of the reasons A was ticked on, how many also carry at least one of categories 1 to 8, and how many carry 9. */
  aWithOtherCategories: { ticked: number; withOneToEight: number; withNine: number };
  /** Reasons the person ticked both of two categories, for the pairs asked about. */
  coTicks: { a: ReasonCategory; b: ReasonCategory; both: number; aOnly: number; bOnly: number }[];
  /** Tags that contradict each other as recorded. */
  clashes: Clash[];
}

const percent = (num: number, den: number): number => (den === 0 ? 0 : Math.floor((num * 200 + den) / (den * 2)));

function agreement(reasons: readonly TaggedReason[], label: string, code: (text: string) => readonly ReasonCategory[]): CodingAgreement {
  return {
    label,
    perCategory: REASON_CATEGORIES.map((category) => {
      let both = 0;
      let humanOnly = 0;
      let ruleOnly = 0;
      let neither = 0;
      for (const r of reasons) {
        const human = r.categories.includes(category);
        const rule = code(r.text).includes(category);
        if (human && rule) both += 1;
        else if (human) humanOnly += 1;
        else if (rule) ruleOnly += 1;
        else neither += 1;
      }
      return { category, both, humanOnly, ruleOnly, neither, agreementPercent: percent(both + neither, reasons.length) };
    }),
  };
}

export const FROZEN_LABEL = "frozen (primary)";
export const AMENDED_LABEL = "amended balance coding (exploratory)";

/** The pairs whose overlap the person flagged: 6 with earmarking, balance with affordability is the A table. */
const CO_TICK_PAIRS: readonly [ReasonCategory, ReasonCategory][] = [["keeping_options_open", "earmarking"]];

export function agreementReport(reasons: readonly TaggedReason[]): AgreementReport {
  const ticked = reasons.filter((r) => r.affordabilityOnly);
  const frozenCodes = (r: TaggedReason): readonly ReasonCategory[] => codeReason(r.text);
  const amended = (r: TaggedReason): readonly ReasonCategory[] => amendedCodes(r.text);
  return {
    reasons: reasons.length,
    noneOfThese: reasons.filter((r) => r.noneOfThese).length,
    frozen: agreement(reasons, FROZEN_LABEL, codeReason),
    amended: agreement(reasons, AMENDED_LABEL, amendedCodes),
    affordability: {
      ticked: ticked.length,
      frozen: {
        label: FROZEN_LABEL,
        inCategory3: ticked.filter((r) => frozenCodes(r).includes("balance_size")).length,
        inCategory9: ticked.filter((r) => frozenCodes(r).includes("no_asset_reason")).length,
        inOtherCategoriesOnly: ticked.filter((r) => !frozenCodes(r).includes("balance_size") && !frozenCodes(r).includes("no_asset_reason")).length,
      },
      amended: {
        label: AMENDED_LABEL,
        affordabilityFired: ticked.filter((r) => readBalance(r.text).affordability).length,
        relativeFired: ticked.filter((r) => readBalance(r.text).relative).length,
        inCategory9: ticked.filter((r) => amended(r).includes("no_asset_reason")).length,
        inCategory3: ticked.filter((r) => amended(r).includes("balance_size")).length,
      },
      notTickedButAffordabilityFired: reasons.filter((r) => !r.affordabilityOnly && readBalance(r.text).affordability).length,
    },
    affordabilityFlag: {
      both: reasons.filter((r) => r.affordabilityOnly && readBalance(r.text).affordability).length,
      humanOnly: reasons.filter((r) => r.affordabilityOnly && !readBalance(r.text).affordability).length,
      ruleOnly: reasons.filter((r) => !r.affordabilityOnly && readBalance(r.text).affordability).length,
      neither: reasons.filter((r) => !r.affordabilityOnly && !readBalance(r.text).affordability).length,
    },
    aWithOtherCategories: {
      ticked: ticked.length,
      withOneToEight: ticked.filter((r) => r.categories.some((c) => c !== "no_asset_reason")).length,
      withNine: ticked.filter((r) => r.categories.includes("no_asset_reason")).length,
    },
    coTicks: CO_TICK_PAIRS.map(([a, b]) => ({
      a,
      b,
      both: reasons.filter((r) => r.categories.includes(a) && r.categories.includes(b)).length,
      aOnly: reasons.filter((r) => r.categories.includes(a) && !r.categories.includes(b)).length,
      bOnly: reasons.filter((r) => !r.categories.includes(a) && r.categories.includes(b)).length,
    })),
    clashes: clashesOf(reasons),
  };
}

/** Tags that cannot all be true as recorded: category 9 (says nothing at all about the assets) with any of 1 to 8, A with 9, "none of these" with anything. */
export function clashesOf(reasons: readonly TaggedReason[]): Clash[] {
  const out: Clash[] = [];
  for (const r of reasons) {
    const others = r.categories.filter((c) => c !== "no_asset_reason");
    if (r.categories.includes("no_asset_reason") && others.length > 0) {
      out.push({ id: r.id, categories: r.categories, affordabilityOnly: r.affordabilityOnly, noneOfThese: r.noneOfThese, why: "category 9 (says nothing at all about the assets) ticked with a category that is about an asset" });
    } else if (r.categories.includes("no_asset_reason") && r.affordabilityOnly) {
      out.push({ id: r.id, categories: r.categories, affordabilityOnly: r.affordabilityOnly, noneOfThese: r.noneOfThese, why: "A (mentions affordability, an asset) ticked with category 9" });
    } else if (r.noneOfThese && (r.categories.length > 0 || r.affordabilityOnly)) {
      out.push({ id: r.id, categories: r.categories, affordabilityOnly: r.affordabilityOnly, noneOfThese: r.noneOfThese, why: "none of these ticked with another box" });
    }
  }
  return out;
}
