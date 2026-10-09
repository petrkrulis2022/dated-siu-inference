/**
 * The nine reason categories of the probe battery (docs/marketplace_plan.md §14.6), as keyword and phrase rules. They are written down and
 * committed before any probe data exists, and `RULES_FINGERPRINT` is recorded with every battery file, so an analysis can refuse a file whose
 * rules are not these. No model codes another model's reasons: a reason is coded here, by these patterns and nothing else, and a human check
 * (a random 40, blind) measures how far the patterns agree with a reader.
 *
 * The patterns were written from the plain meaning of each category and from the vocabulary of the stated reasons in the v8 run
 * (`data/lab/runs/lab-2026-10-08T16-36-04-480Z-overview.md`); no probe reply existed when they were written. A reason may carry several codes.
 * A non-empty reason that fires none of categories 1 to 8 is coded 9, "no asset reason": it cites the need or the obligation and nothing that
 * says why one asset and not the other. An absent or blank reason has no codes at all and is counted as "no reason given".
 */
import { createHash } from "node:crypto";

export const REASON_CATEGORIES = [
  "earmarking",
  "price_direction",
  "balance_size",
  "familiarity",
  "following_brief",
  "keeping_options_open",
  "expiry",
  "cost_efficiency",
  "no_asset_reason",
] as const;
export type ReasonCategory = (typeof REASON_CATEGORIES)[number];

/** What a person sees for each category in the tagging page. */
export const CATEGORY_LABELS: Readonly<Record<ReasonCategory, string>> = {
  earmarking: "Earmarking — one asset assigned to a purpose (\"preserve X for raw work\", \"keep X for later needs\")",
  price_direction: "Price direction — the print rising, falling, up, down, a trend",
  balance_size: "Balance size — \"I have plenty or enough of X\", an amount held",
  familiarity: "Familiarity — USDC as simpler, standard, safe or the default",
  following_brief: "Following the brief — the neutrality sentence, the scoring rule, \"as stated\"",
  keeping_options_open: "Keeping options open — flexibility, liquidity, not committing",
  expiry: "Expiry — the window closing, fSIU expiring",
  cost_efficiency: "Cost or efficiency — cheaper, minimal, economical",
  no_asset_reason: "No asset reason — the need or the obligation only, nothing about which asset",
};

const CONSERVE = String.raw`(?:preserv\w*|reserv\w*|sav(?:e|es|ed|ing)|keep(?:s|ing)?|conserv\w*|retain\w*|set(?:s|ting)? aside|earmark\w*|hold(?:s|ing)? (?:on to|back)|leav(?:e|es|ing) me with|stay(?:s|ing)? (?:available|in reserve))`;
const PURPOSE = String.raw`(?:raw[- ]?work|future|later|upcoming|remaining|next (?:round|need|purchase)|rounds? \d|(?:other|further|later|my|own) needs?|purchases?|deliver\w*|obligations?|for (?:the )?(?:job|jobs|quotes))`;
const ASSET = String.raw`(?:usdc|fsiu|claims?|dollars?|usd|msiu|siu)`;

/** One rule is a pattern, or a list of patterns that must ALL match (familiarity needs USDC named and a word for it). Matching is case-insensitive on text with curly quotes straightened. */
type Rule = RegExp | readonly RegExp[];

/** Each category's rules; a category fires when any of its rules does. */
const RULES: Readonly<Record<Exclude<ReasonCategory, "no_asset_reason">, readonly Rule[]>> = {
  earmarking: [
    new RegExp(String.raw`\b${CONSERVE}\b[^.;]{0,80}\b(?:for|to cover|so (?:that )?i (?:can|have|still|am)|until)\b[^.;]{0,60}\b${PURPOSE}`, "i"),
    new RegExp(String.raw`\b${ASSET}\b[^.;]{0,25}\bfor (?:the )?(?:raw[- ]?work|future|later|upcoming|remaining|other needs?|my needs?)`, "i"),
    /\b(?:earmark\w*|set aside|in reserve)\b/i,
    new RegExp(String.raw`\b(?:keep|keeps|keeping|preserve|preserves|preserving|save|saves|saving|reserve|reserves|reserving)\s+(?:my |the |our )?${ASSET}\s+for\b`, "i"),
  ],
  price_direction: [
    /\b(?:print|price|rate)\b[^.;]{0,50}\b(?:ris(?:e|es|ing|en)|rose|fall(?:s|ing|en)?|fell|drop(?:s|ped|ping)?|decreas\w*|increas\w*|up|down|higher|lower|climb\w*|declin\w*|moved|moves|moving)\b/i,
    /\b(?:rising|falling|appreciat\w*|depreciat\w*|trend\w*|momentum|higher print|lower print|if the print|print (?:is|has) (?:up|down)|print (?:may|might|could|will|would))\b/i,
  ],
  balance_size: [
    /\b(?:plenty|enough|sufficient|ample|abundant|adequate|surplus|limited|scarce|running (?:low|out)|left over|more than (?:enough|i need))\b[^.;]{0,40}\b(?:usdc|fsiu|balance|funds|holdings?|msiu|minor units|claims?)\b/i,
    /\b(?:usdc|fsiu|balance|holdings?|funds|claims?)\b[^.;]{0,30}\b(?:plenty|enough|sufficient|ample|limited|low|scarce|short|larger|bigger|smaller|most of|more of|less of)\b/i,
    /\bbalance of\b/i,
    /\b(?:larger|bigger|smaller|largest|biggest|most of my|bulk of my|more of my)\b[^.;]{0,20}\b(?:holdings?|balance|usdc|fsiu|position|asset)/i,
    /\bi (?:hold|have)\b[^.;]{0,15}\b(?:more|less|most|much)\b/i,
    /\bremaining (?:usdc|fsiu|balance|funds|holdings?|\d)/i,
    /\bi (?:hold|have|own)\b[^.;]{0,20}\d[\d,.]*\s*(?:msiu|usdc|minor)/i,
  ],
  familiarity: [
    [
      /\b(?:usdc|dollars?|usd|stablecoin)\b/i,
      /\b(?:simpl(?:e|er|est)|standard|safe(?:r|st)?|default|familiar|conventional|stable|trusted|well[- ]known|ordinary|usual|common(?:ly)?|reliab\w*|widely (?:accepted|used)|universally|certain(?:ty)?)\b/i,
    ],
  ],
  following_brief: [
    /\b(?:as (?:stated|described|specified|noted|instructed|told|written)|the brief|brief says|neutral(?:ity)?|per the (?:brief|rules?|instructions?|lab)|according to (?:the )?(?:brief|rules?|instructions?|lab)|scoring rule|the (?:score|scoring|result) (?:rule|is|counts|treats))\b/i,
    /\b(?:(?:converting|conversion) (?:changes|does|makes) (?:nothing|no difference)|changes nothing about (?:my|the) result|never required to convert|not required to convert|same (?:result|score) either way|result (?:is|stays|remains) the same|indifferent|equivalent (?:value|result)s?|(?:equivalent|equal|same) (?:in )?value|worth the same|equally valued|valued at the current print)\b/i,
  ],
  keeping_options_open: [
    /\b(?:flexib\w*|liquid\w*|options? open|keep(?:ing)? (?:my )?options|optionality|not commit\w*|avoid committing|without committing|hedg\w*|diversif\w*|keep(?:s|ing)? both|retain(?:s|ing)? both|hold(?:s|ing)? both|some of each|a bit of each|balanc(?:e|es|ed|ing) (?:my )?(?:holdings|assets|wallet|exposure))\b/i,
  ],
  expiry: [
    /\b(?:expir\w*|lapse\w*|window (?:clos\w*|end\w*)|clos(?:es|ing) (?:of )?the window|before the window|at (?:the )?close|use[- ]it[- ]or[- ]lose[- ]it|worthless|time[- ]limited|deadline|end of the (?:window|lab)|until (?:the )?close)\b/i,
  ],
  cost_efficiency: [
    /\b(?:cheap\w*|minimal|economical|economic|efficien\w*|saves? (?:money|cost|usd|dollars?|usdc)|least (?:costly|expensive)|lower (?:cost|price)|costs? (?:less|fewer|more)|(?:more|less|in)expensive|expensive|cost[- ]effective|costly|cost[- ]saving|better (?:value|deal)|spend less|cost[- ]efficient)\b/i,
  ],
};

/** A quote's own expiry is not the fSIU's: these are removed before the expiry rule is read. */
const NOT_EXPIRY = /\b(?:quotes?'?s? expir\w*|expir\w* of (?:the |a |this )?quote|expiresinseconds|before the quote expires)\b/gi;

const normalise = (text: string): string => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The categories a stated reason or a thinking summary falls in, in the order of `REASON_CATEGORIES`. Empty for a blank text. */
export function codeReason(text: string | undefined): ReasonCategory[] {
  const t = normalise(text ?? "").trim();
  if (t === "") return [];
  const found: ReasonCategory[] = [];
  for (const category of REASON_CATEGORIES) {
    if (category === "no_asset_reason") continue;
    const subject = category === "expiry" ? t.replace(NOT_EXPIRY, " ") : t;
    if (RULES[category].some((r) => (Array.isArray(r) ? r.every((x) => x.test(subject)) : (r as RegExp).test(subject)))) found.push(category);
  }
  return found.length === 0 ? ["no_asset_reason"] : found;
}

/** True where a text cites a category. */
export const cites = (text: string | undefined, category: ReasonCategory): boolean => codeReason(text).includes(category);

/** A hash of every rule, recorded with each battery file: an analysis refuses a file whose rules are not these. */
export function rulesFingerprint(): string {
  const show = (r: RegExp): string => `${r.source}/${r.flags}`;
  const parts = (Object.keys(RULES) as (keyof typeof RULES)[]).map((c) => [c, RULES[c].map((r) => (Array.isArray(r) ? (r as readonly RegExp[]).map(show) : show(r as RegExp)))]);
  return createHash("sha256")
    .update(JSON.stringify([parts, NOT_EXPIRY.source, NOT_EXPIRY.flags]))
    .digest("hex");
}

// ---- The balance-size amendment (D65) -----------------------------------------------------------------------------------------------------------------
//
// Made after the pilot replies and the practice tagging round were seen, and before any stage-1 reply was read or coded; it is an addition, not a change:
// the rules above, and `rulesFingerprint()`, are exactly as they were frozen. In this design both assets always cover every payment, so "I have enough X"
// only says the payment is possible, and it turns up in every cell. What the P5 and P6 cells test is the other thing: the agent weighing how much it holds
// of one asset against the other. `amendedCodes` is the frozen coding with category 3 meaning only that; the analysis reports it beside the frozen coding,
// never in place of it, and says so.

/** What a reason says about the amount held: that the payment is possible (`affordability`), or that one asset is held in a larger or smaller amount than the other, or is plentiful or scarce, so that it is the one to use or spare (`relative`). */
export interface BalanceReading {
  affordability: boolean;
  relative: boolean;
}

const RELATIVE_BALANCE: readonly RegExp[] = [
  /\b(?:more|less|most|larger|bigger|greater|smaller|fewer|much more|far more|a lot more)\b[^.;]{0,30}\b(?:fsiu|usdc|claims?|holdings?|balance|assets?)\b/i,
  /\bi (?:hold|have|own)\b[^.;]{0,20}\b(?:more|less|most|much more|far more|a lot more)\b/i,
  /\b(?:larger|bigger|largest|biggest|smaller|main|majority|bulk)\b[^.;]{0,15}\b(?:holdings?|balance|position|share|part)\b/i,
  /\b(?:most|majority|bulk) of my\b/i,
  /\b(?:plenty|abundant|surplus|excess|spare)\b[^.;]{0,25}\b(?:fsiu|usdc|claims?|holdings?|balance)\b/i,
  /\b(?:fsiu|usdc|claims?|holdings?|balance)\b[^.;]{0,25}\b(?:plenty|abundant|surplus|excess|spare)\b/i,
  /\b(?:running low|scarce|scarcer|short of|limited)\b[^.;]{0,25}\b(?:fsiu|usdc|claims?|holdings?|balance)\b/i,
  /\b(?:fsiu|usdc|claims?|holdings?|balance)\b[^.;]{0,25}\b(?:running low|scarce|scarcer|limited)\b/i,
];

const AFFORDABILITY_BALANCE: readonly RegExp[] = [
  /\b(?:enough|sufficient|adequate|ample|can afford|able to (?:pay|cover)|have the funds|affordable)\b/i,
  /\bcovers? (?:the|this|that|it)\b/i,
  /\bto cover\b/i,
];

export function readBalance(text: string | undefined): BalanceReading {
  const t = normalise(text ?? "");
  return { affordability: AFFORDABILITY_BALANCE.some((r) => r.test(t)), relative: RELATIVE_BALANCE.some((r) => r.test(t)) };
}

/** The frozen coding with category 3 (`balance_size`) meaning only a relative amount. A reason left with no category is coded 9. A blank reason has none. */
export function amendedCodes(text: string | undefined): ReasonCategory[] {
  const frozen = codeReason(text);
  if (frozen.length === 0) return [];
  const set = new Set<ReasonCategory>(frozen);
  set.delete("no_asset_reason");
  if (readBalance(text).relative) set.add("balance_size");
  else set.delete("balance_size");
  const out = REASON_CATEGORIES.filter((c) => set.has(c));
  return out.length === 0 ? ["no_asset_reason"] : out;
}

/** A hash of the amendment's patterns; the analysis records it beside `rulesFingerprint()` and states which coding each table used. */
export function amendmentFingerprint(): string {
  return createHash("sha256")
    .update(JSON.stringify([RELATIVE_BALANCE.map((r) => `${r.source}/${r.flags}`), AFFORDABILITY_BALANCE.map((r) => `${r.source}/${r.flags}`)]))
    .digest("hex");
}

