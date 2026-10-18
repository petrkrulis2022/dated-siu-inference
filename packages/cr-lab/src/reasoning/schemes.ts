/**
 * The two category schemes for tagging agents' reasoning (D107), approved by the owner before any tagging. They are kept apart because the two kinds of reasoning are about different things:
 * the RESEARCH scheme is for what an agent says while it works out an answer from a data server (the Blockworks trial's MCP mode and snapshot mode), and the PAYMENT scheme is for what an
 * agent says when it decides how to pay (the agent economy, Part 5). Neither is used for the other's reasoning.
 *
 * Each category is defined by what the reasoning is ABOUT, never by words it is likely to contain (the review of D63): a description that lists trigger words leads a reader to tick a box by
 * matching words, which inflates the agreement the blind check exists to measure. `research-codes.ts` keeps the rules' trigger words, and a test keeps them out of these descriptions.
 *
 * RESEARCH, the owner's draft of 2026-10-18 with two additions: "handling units and scale" (agents slipped by a thousandfold in the probe battery's stage 1) and "recovering from tool
 * errors" (agents will meet rate limits and empty results).
 *
 * PAYMENT, the lab's nine categories (docs/marketplace_plan.md §14.6) with last round's fixes carried in: the descriptions are by meaning (D63); the tenth box is an affordability FLAG that can
 * stand beside any of 1 to 8, because that is how the person used it (D69, which superseded D68's "only"); "no asset reason" stands alone, since a reason that names an asset cannot also
 * say nothing about assets (the r-qvvc clash of D69); and the earmarking/keeping-options overlap is stated here in advance instead of being found afterwards.
 *
 * Clicking rules are one function. The tagging page runs `TAG_RULES_SOURCE` and the tests run the same text, so the page and the tests cannot disagree about what may be ticked together.
 */

export interface TagCategory {
  id: string;
  name: string;
  meaning: string;
}

export interface TagScheme {
  id: "research" | "payment";
  title: string;
  /** one sentence for the page: what the passages are */
  about: string;
  categories: readonly TagCategory[];
  /** ids that stand alone: ticking one clears every other box, and ticking any other clears it */
  exclusive: readonly string[];
  /** the id of the "none of these" box, which is always exclusive */
  noneId: string;
  /** a flag that stands beside any non-exclusive category, or alone */
  flag?: TagCategory;
  /** stated in advance, shown to the person tagging */
  notes: readonly string[];
}

export const RESEARCH_SCHEME: TagScheme = {
  id: "research",
  title: "Research reasoning",
  about:
    "Each passage below is something an AI agent wrote while it worked out an answer from a data server: what it was thinking, or what it said it was about to do.",
  categories: [
    {
      id: "discovery",
      name: "Discovery",
      meaning:
        "The agent is working out what the data server holds, and which dataset or tool can answer the question.",
    },
    {
      id: "finding_entity_id",
      name: "Finding an entity's identifier",
      meaning:
        "The agent is working out how a named venue, protocol, token, chain or issuer is identified in the data, so that it can ask for it.",
    },
    {
      id: "choosing_window",
      name: "Choosing the window",
      meaning:
        "The agent is deciding which period of time to ask for, and where that period begins and ends.",
    },
    {
      id: "choosing_fields",
      name: "Choosing the fields",
      meaning:
        "The agent is deciding which measurements or series to ask for, and how many of them.",
    },
    {
      id: "checking_completeness",
      name: "Checking completeness",
      meaning:
        "The agent is checking whether it has everything the question needs, or noticing that something is absent.",
    },
    {
      id: "planning_arithmetic",
      name: "Planning the arithmetic",
      meaning:
        "The agent is deciding how to turn the figures it has into the requested answer: how to combine, compare or order them, and to how many places to give them.",
    },
    {
      id: "handling_units_scale",
      name: "Handling units and scale",
      meaning:
        "The agent is reasoning about what unit a figure is in, or how large it is, or changing a figure from one unit or size to another.",
    },
    {
      id: "recovering_from_errors",
      name: "Recovering from tool errors",
      meaning:
        "The agent is reacting to a call that did not work, or that gave back no content, by changing its approach or making the call once more.",
    },
    {
      id: "giving_up_or_filling_in",
      name: "Giving up or filling in",
      meaning:
        "The agent decides to stop without the data it wanted, or to put in a value it did not read.",
    },
    {
      id: "restraining_cost",
      name: "Restraining cost",
      meaning:
        "The agent holds back how much it reads or how often it asks, because of the size of what comes back, what it would use up, or a ceiling it expects.",
    },
    {
      id: "none",
      name: "None of these",
      meaning:
        "Anything else: restating the task, writing the answer out, or a remark that fits none of the above.",
    },
  ],
  exclusive: ["none"],
  noneId: "none",
  notes: [
    "Tick every box that fits: one passage can be about several things.",
    "Go by what the passage means, not by whether it contains a particular word.",
    "Figures that came from the data are hidden and shown as [figure]. The agent's own units and scale words (thousand, million, USD, minor units) are left in, so you can see a mistake about scale without seeing the figure.",
  ],
};

export const PAYMENT_SCHEME: TagScheme = {
  id: "payment",
  title: "Payment reasoning",
  about:
    "Each reason below is a line an AI agent wrote about how to pay in a small market: in USDC (dollars) or in fSIU (a claim for work).",
  categories: [
    {
      id: "earmarking",
      name: "Earmarking",
      meaning: "The agent assigns one asset to a particular later use.",
    },
    {
      id: "price_direction",
      name: "Price direction",
      meaning: "The direction the price is heading is part of the justification.",
    },
    {
      id: "balance_size",
      name: "Balance size",
      meaning:
        "Which asset the agent holds more of, or less of, and so spends or spares, is part of the justification. A remark that the payment is possible is the affordability flag, not this one.",
    },
    {
      id: "familiarity",
      name: "Familiarity",
      meaning: "One asset is chosen because the agent finds it the obvious one, or knows it best.",
    },
    {
      id: "following_brief",
      name: "Following the brief",
      meaning: "The agent cites what it was told in its instructions about how results count.",
    },
    {
      id: "keeping_options_open",
      name: "Keeping options open",
      meaning: "The agent avoids tying itself down, or wants other actions to stay possible later.",
    },
    {
      id: "expiry",
      name: "Expiry",
      meaning:
        "The agent refers to time running out: the window ending, or a claim ceasing to be valid.",
    },
    {
      id: "cost_efficiency",
      name: "Cost or efficiency",
      meaning: "What one route costs compared with the other is part of the justification.",
    },
    {
      id: "no_asset_reason",
      name: "No asset reason",
      meaning:
        "The reason says nothing at all about the assets: only the need, the obligation, or the order in which to take steps.",
    },
    {
      id: "none",
      name: "None of these",
      meaning:
        "It says something about the choice of asset that fits none of the above and is not the affordability flag.",
    },
  ],
  exclusive: ["no_asset_reason", "none"],
  noneId: "none",
  flag: {
    id: "mentions_affordability",
    name: "Mentions affordability",
    meaning:
      "The agent remarks that it has enough of an asset to pay. It can stand beside any of the categories above except No asset reason and None of these.",
  },
  notes: [
    "Tick every box that fits: one reason can be about several things.",
    "Earmarking and Keeping options open overlap: a reason that sets an asset aside for later is often both. This was seen in the lab's first tagging round and is reported as an overlap, never as a mistake. Tick each that fits.",
    "No asset reason stands alone: a reason that names an asset in its justification cannot also say nothing about assets.",
  ],
};

export const SCHEMES: Readonly<Record<TagScheme["id"], TagScheme>> = {
  research: RESEARCH_SCHEME,
  payment: PAYMENT_SCHEME,
};

/**
 * What the boxes do to each other. `state` is `{ids: [category ids], flag: bool}` as the boxes stand after the change; `changed` is `{kind: "cat" | "flag", id?: string, on: bool}`. The box just
 * ticked wins: an exclusive category clears every other box (flag included), any other category or the flag clears the exclusive ones. One source: the page runs this text, and a test runs it too.
 */
export const TAG_RULES_SOURCE = `
function applyChoice(scheme, state, changed) {
  var excl = scheme.exclusive;
  var ids = state.ids.slice(), flag = !!state.flag;
  var isExcl = function (id) { return excl.indexOf(id) !== -1; };
  if (changed.on) {
    if (changed.kind === "cat" && isExcl(changed.id)) { ids = [changed.id]; flag = false; }
    else { ids = ids.filter(function (id) { return !isExcl(id); }); }
  }
  return { ids: ids, flag: flag };
}
function isAnswered(t) { return !!t && (t.flag || t.ids.length > 0); }
`;

interface Choice {
  ids: string[];
  flag: boolean;
}
const rules = new Function(
  `${TAG_RULES_SOURCE}\nreturn { applyChoice: applyChoice, isAnswered: isAnswered };`,
)() as {
  applyChoice: (
    scheme: Pick<TagScheme, "exclusive">,
    state: Choice,
    changed: { kind: "cat" | "flag"; id?: string; on: boolean },
  ) => Choice;
  isAnswered: (t: Choice | undefined) => boolean;
};
export const applyChoice = rules.applyChoice;
export const isAnswered = rules.isAnswered;
