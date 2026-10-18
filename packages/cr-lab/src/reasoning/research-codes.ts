/**
 * The keyword rules for the RESEARCH scheme (D107): each category as phrase patterns, written from the plain meaning of the category and committed before any agent reasoning from the trial
 * exists (the only text they were checked against is the illustrative passages in the tests, which are written for them and are not agent output). `researchRulesFingerprint()` is the sha256
 * of every pattern and the category order; a tagging analysis records it and refuses a file whose rules differ, as the probe battery's did.
 *
 * No model codes another model's reasoning (invariant 6). A passage is coded by these patterns and nothing else, and a blind human sample (a random 40) measures how far the patterns agree with a
 * reader: per category, with kappa, so a category the rules cannot find is visible rather than averaged away. A passage may carry several codes. A non-empty passage that fires none of the
 * ten categories is coded `none`; an empty one has no code at all.
 *
 * `RESEARCH_TRIGGER_WORDS` lists the words each category's patterns key on. A test keeps these out of the category descriptions the person tagging reads (the review of D63), and checks that
 * every listed word really is in a pattern, so the list cannot go stale.
 */
import { createHash } from "node:crypto";
import { RESEARCH_SCHEME } from "./schemes.js";

export const RESEARCH_CATEGORY_IDS = RESEARCH_SCHEME.categories.map((c) => c.id);
export type ResearchCategory = (typeof RESEARCH_CATEGORY_IDS)[number];

type RuleId = Exclude<ResearchCategory, "none">;

/** Each category's patterns; a category fires when any one does. Matching is case-insensitive on text with curly quotes straightened. */
const RULES: Readonly<Record<RuleId, readonly RegExp[]>> = {
  discovery: [
    /\b(?:catalog\w*|explor\w+|what (?:data|datasets?|models?|tools?|metrics?) (?:is|are|does|do|exist|exists)|which (?:dataset|model|tool) (?:has|holds|contains|covers|answers)|see what|available (?:data|datasets|models|tools|series|metrics))\b/i,
    /\blist(?:ing)? (?:the |all )?(?:models|datasets|tools|series|what)\b/i,
  ],
  finding_entity_id: [
    /\b(?:slug|identifier)s?\b/i,
    /\b(?:exact|correct|right|proper) (?:id|name|spelling)\b/i,
    /\b(?:find|finding|look(?:ing)? up|search(?:ing)? for) (?:the )?(?:id|ids)\b/i,
    /\b(?:id|ids)\b[^.;]{0,30}\b(?:of|for|is|are|under|called|named)\b/i,
  ],
  choosing_window: [
    /\b(?:start|end) (?:date|time|day|month)\b/i,
    /\b(?:inclusive|exclusive)\b/i,
    /\bdate range\b|\btimeframe\b|\btime frame\b/i,
    /\b(?:complete|full|whole|last) (?:calendar )?(?:months?|quarters?)\b/i,
    /\b(?:from|between) \d{4}-\d{2}(?:-\d{2})?\b[^.;]{0,20}\b(?:to|and|through)\b/i,
  ],
  choosing_fields: [
    /\bselections?\b/i,
    /\b(?:which|what) (?:metrics?|fields?|columns?)\b/i,
    /\b(?:only|just) (?:the )?(?:metrics?|fields?|columns?)\b/i,
    /\b(?:metrics?|fields?|columns?|series)\b[^.;]{0,40}\b(?:i need|needed|to request|to ask for|to select|to include|to omit)\b/i,
  ],
  checking_completeness: [
    /\b(?:missing|incomplete|paginat\w+|next page|more pages?|remaining (?:pages?|venues?|protocols?|series|rows))\b/i,
    /\b(?:cover(?:ed|s)?|got|have|read|fetched) (?:all|every|each)\b/i,
    /\b(?:all|every) (?:the )?(?:venues?|protocols?|series|pages?|chains?|issuers?|months?|days?)\b[^.;]{0,40}\b(?:covered|present|included|accounted|returned|fetched|read)\b/i,
    /\b(?:make sure|check(?:ing)?|verify(?:ing)?) (?:that )?(?:i|we|everything|nothing|all)\b/i,
  ],
  planning_arithmetic: [
    /\b(?:sum|add|divide|multiply|subtract|compute|calculate|rank|sort|round)\b[^.;]{0,30}\b(?:them|these|those|up|by|each|the|then|to)\b/i,
    /\b(?:denominator|numerator|ratio|percentage|decimal places?)\b/i,
    /\bthen (?:sum|add|divide|compute|calculate|rank|sort)\b/i,
    /\bshare of\b[^.;]{0,30}\b(?:total|combined|sum)\b/i,
  ],
  handling_units_scale: [
    /\b(?:minor units?|orders? of magnitude|magnitude)\b/i,
    /\b(?:thousandfold|1000x|x ?1000|10\^\d|a thousand times|a million times|thousands? of|millions? of|billions? of)\b/i,
    /\b(?:in|as) (?:usd|dollars|cents|thousands|millions|billions|wei)\b/i,
    /\b(?:unit|units|scale|scaled|scaling)\b[^.;]{0,40}\b(?:mismatch|wrong|off|differ\w*|convert\w*|mean|means|expressed|denominated)\b/i,
    /\bconvert\w*\b[^.;]{0,40}\b(?:to|into|from)\b/i,
  ],
  recovering_from_errors: [
    /\b(?:error|errored|failed|failure|rate[- ]?limit(?:ed)?|429|too many requests|timed? ?out|rejected|invalid|unexpected)\b/i,
    /\b(?:retry|retrying|try again|trying again|again with)\b/i,
    /\b(?:empty (?:result|response|list|array)|no results?|returned nothing|came back empty|not found|nothing came back)\b/i,
  ],
  giving_up_or_filling_in: [
    /\b(?:placeholder|stand-in|made[- ]up|make (?:it|them) up|fill(?:ing)? in)\b/i,
    /\b(?:guess|guessing|estimate|approximate)\b/i,
    /\b(?:can(?:'| no)t|cannot|unable to|couldn't) (?:find|get|retrieve|obtain|access|read)\b/i,
    /\b(?:give up|giving up|no data (?:available|exists)|not available)\b/i,
    /\bi(?:'ll| will) (?:just )?(?:use|put|write|report) (?:0|zero|a (?:default|placeholder))\b/i,
  ],
  restraining_cost: [
    /\b(?:too (?:large|big|many|expensive|much)|expensive|budget|cheaper|cheapest)\b/i,
    /\b(?:token|cost|size|call|request)s? (?:limit|budget|cost|count)\b/i,
    /\b(?:avoid|reduce|minimi[sz]e|limit|keep) (?:the )?(?:size|calls?|requests?|number of (?:calls|requests|series)|response)\b/i,
    /\b(?:fewer|smaller) (?:calls|requests|series|pages|responses)\b/i,
    /\bpage ?size\b/i,
  ],
};

/**
 * The words each category's patterns key on; none of them may appear in the descriptions the person tagging reads. A word is matched whole; a trailing `*` makes it a stem
 * ("explor*" for explore, exploring, exploration).
 */
export const RESEARCH_TRIGGER_WORDS: Readonly<Record<RuleId, readonly string[]>> = {
  discovery: ["catalog*", "explor*", "available", "list"],
  finding_entity_id: ["slug", "identifier", "id", "ids"],
  choosing_window: ["inclusive", "exclusive", "timeframe", "date range", "calendar"],
  choosing_fields: ["selections", "metrics", "fields", "columns"],
  checking_completeness: ["missing", "incomplete", "paginat*", "next page", "more pages", "verify"],
  planning_arithmetic: [
    "sum",
    "divide",
    "multiply",
    "subtract",
    "compute",
    "calculate",
    "rank",
    "sort",
    "round",
    "denominator",
    "ratio",
    "percentage",
  ],
  handling_units_scale: ["minor unit", "magnitude", "thousandfold", "1000x", "convert*"],
  recovering_from_errors: [
    "error",
    "failed",
    "rate limit",
    "429",
    "timed out",
    "retry",
    "try again",
    "trying again",
    "returned nothing",
    "empty result",
    "no results",
    "not found",
  ],
  giving_up_or_filling_in: [
    "placeholder",
    "stand-in",
    "fill in",
    "guess",
    "estimate",
    "approximate",
    "give up",
    "unable to",
  ],
  restraining_cost: [
    "too large",
    "too big",
    "too many",
    "expensive",
    "budget",
    "cheaper",
    "page size",
  ],
};

const straighten = (t: string): string => t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/** The categories a passage is coded with, in category order. An empty passage has none; a passage that fires nothing is `none`. */
export function codeResearch(text: string | undefined): ResearchCategory[] {
  if (text === undefined || text.trim() === "") return [];
  const t = straighten(text);
  const hit = (Object.keys(RULES) as RuleId[]).filter((c) => RULES[c].some((r) => r.test(t)));
  const ordered = RESEARCH_CATEGORY_IDS.filter((c) => (hit as string[]).includes(c));
  return ordered.length > 0 ? ordered : ["none"];
}

/** sha256 of the category order and every pattern's source and flags: recorded with any analysis that uses these rules. */
export function researchRulesFingerprint(): string {
  const h = createHash("sha256");
  h.update(RESEARCH_CATEGORY_IDS.join(",") + "\n");
  for (const c of Object.keys(RULES) as RuleId[])
    for (const r of RULES[c]) h.update(`${c}\t${r.source}\t${r.flags}\n`);
  return h.digest("hex");
}

/** For the test that the trigger-word list is honest: the pattern sources of a category. */
export const researchPatternSources = (c: RuleId): string[] => RULES[c].map((r) => r.source);
