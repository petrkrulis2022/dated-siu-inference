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
  /** Box A. */
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

export interface AgreementReport {
  reasons: number;
  noneOfThese: number;
  frozen: CodingAgreement;
  amended: CodingAgreement;
  affordability: AffordabilityMapping;
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
  };
}
