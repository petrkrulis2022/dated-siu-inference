/**
 * The reasoning probe battery's screens (docs/marketplace_plan.md §14). Each cell is one real turn of the lab, rendered by the lab's own
 * code, in which a trader holds a quote to pay and must choose a route: the baseline P0, nine cells that each change one thing, and three
 * trend cells in a six-round lab. A model is shown the screen under one of three arms (§14.3) and what it chooses is read from its reply.
 *
 * Nothing here is written by hand except the one edit each cell makes, and every edit asserts it matched, so a change to the brief or the
 * loop's reply format breaks the battery loudly rather than quietly turning a cell into its baseline.
 *
 * Cells are probe-only. Some state a counterfactual (P8 states a scoring rule the lab does not use; P10 and P11 show a history line the lab
 * does not show, with the agent's own stated reason beside the call); none of it is ever put in a lab run.
 */
import { assembleContext, type ToolCallRecord } from "../context/assemble.js";
import { composeBoard } from "../loop/full-run.js";
import { parseModelResponse } from "../loop/parse-tool-call.js";
import { buildTurnPrompt } from "../loop/prompt.js";
import type { ToolName } from "../tools/index.js";
import { buildQuoteBody, type QuoteBody, type TouchstoneQuote } from "@touchstone/sdk";
import { renderLabAction, renderLabInfo } from "./board.js";
import { LabBooks } from "./books.js";
import { buildLabBrief } from "./briefs.js";
import { DEFAULT_PARAMS, LAB_TRADERS, SEAT_OF, buildEconomy, needsOf, type Economy, type LabParams, type Need, type TraderLabel } from "./economy.js";
import { referenceExecutor } from "./jobs.js";
import {
  LAB_QUOTE_PRECISION,
  milliSiuAsUsdcMinor,
  openingMilliSiuPerTrader,
  openingUsdcMinor,
  priceMilliSiu,
  printNano,
  printRate,
  quoteTerms,
  usdcMinorAsMilliSiu,
} from "./money.js";
import { PROBE_PRINT, sha256 } from "./probe.js";
import { buildPrintPath, printIdOfRound, reachablePrints, stepDown, stepUp, type PrintPath } from "./prints.js";
import { LAB_TRADER_TOOLS } from "./roster.js";
import { FIXED_ROUTE_ORDER, type PayTool, type RouteOrder } from "./route-order.js";
import { LabService, labQuoteBoard } from "./service.js";
import { LAB_TOOL_DESCRIPTIONS } from "./tools.js";

export type Arm = "A" | "B" | "C";
export const ARMS: readonly Arm[] = ["A", "B", "C"];

export const CELL_IDS = ["P0", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11", "T1", "T2", "T3"] as const;
export type CellId = (typeof CELL_IDS)[number];

export interface CellDefinition {
  id: CellId;
  /** The one thing this cell changes, in the plan's words (§14.5). */
  change: string;
  /** What the cell is compared against (§14.5). */
  against: readonly CellId[];
}

export const CELLS: Readonly<Record<CellId, CellDefinition>> = {
  P0: { id: "P0", change: "baseline: round 2, print up 15% on round 1, one unit of raw work still to buy, the opening wallet, one quote to pay, USDC listed first", against: [] },
  P3: { id: "P3", change: "no raw work still to buy", against: ["P0"] },
  P4: { id: "P4", change: "two units of raw work still to buy", against: ["P0"] },
  P5: { id: "P5", change: "wallet weighted to USDC at equal total value", against: ["P0"] },
  P6: { id: "P6", change: "wallet weighted to fSIU at equal total value", against: ["P0"] },
  P7: { id: "P7", change: "the \"converting changes nothing\" sentence removed", against: ["P0"] },
  P8: { id: "P8", change: "the score stated as counting expired fSIU for nothing", against: ["P0"] },
  P9: { id: "P9", change: "fSIU listed first (assets and routes)", against: ["P0"] },
  P10: { id: "P10", change: "history shows an earlier USDC payment with the stated purpose \"preserve fSIU for raw work\", one unit still to buy", against: ["P0"] },
  P11: { id: "P11", change: "the history of P10, but no raw work left to buy", against: ["P10"] },
  T1: { id: "T1", change: "six-round lab, screen at round 5, prints rising 15% each step", against: ["T2", "T3"] },
  T2: { id: "T2", change: "six-round lab, screen at round 5, prints falling 15% each step", against: ["T1", "T3"] },
  T3: { id: "T3", change: "six-round lab, screen at round 5, prints flat", against: ["T1", "T2"] },
};

/** The stated purpose P10 and P11 show beside the earlier payment (§14.5). */
export const EARMARK_REASON = "preserve fSIU for raw work";

/** The fSIU-first order of P9: the asset, and the routes in the brief's examples and in the tool list. */
export const FSIU_FIRST_ORDER: RouteOrder = { assetFirst: "fsiu", tools: ["pay_with_held_claim", "pay_with_usdc", "pay_split"] };

interface Variation {
  owed: 0 | 1 | 2;
  wallet: "opening" | "usdc" | "fsiu";
  dropNeutrality: boolean;
  expiryScoring: boolean;
  order: RouteOrder;
  history: boolean;
  trend?: "rising" | "falling" | "flat";
}

const BASE: Variation = { owed: 1, wallet: "opening", dropNeutrality: false, expiryScoring: false, order: FIXED_ROUTE_ORDER, history: false };

const VARIATION: Readonly<Record<CellId, Variation>> = {
  P0: BASE,
  P3: { ...BASE, owed: 0 },
  P4: { ...BASE, owed: 2 },
  P5: { ...BASE, wallet: "usdc" },
  P6: { ...BASE, wallet: "fsiu" },
  P7: { ...BASE, dropNeutrality: true },
  P8: { ...BASE, expiryScoring: true },
  P9: { ...BASE, order: FSIU_FIRST_ORDER },
  P10: { ...BASE, history: true },
  P11: { ...BASE, owed: 0, history: true },
  T1: { ...BASE, trend: "rising" },
  T2: { ...BASE, trend: "falling" },
  T3: { ...BASE, trend: "flat" },
};

/** Three-round cells are the screen of round 2; trend cells are the screen of round 5 of a six-round lab (§14.5). */
const SIX_ROUND_PARAMS: LabParams = { ...DEFAULT_PARAMS, rounds: 6 };
const STEP_BPS = DEFAULT_PARAMS.printStepBps;
/** What share of the total value the weighted wallets hold in the heavier asset (§14.5: "weighted"), in tenths of a percent. */
const WEIGHT_PERMILLE = 800n;

export interface BatterySetup {
  seed: number;
  rounds: number;
  /** The round the screen is taken at. */
  atRound: number;
  me: TraderLabel;
  /** Its earlier need (bought and met before the screen, D62) and its later need (the quote in front). */
  needA: Need;
  needB: Need;
  /** Traders with an open need on `me` at the screen's round: each can have paid it for a job. */
  buyers: TraderLabel[];
}

/**
 * The smallest seed whose economy gives the cells what they need: a trader with exactly two needs, both open at the screen's round, and two other traders
 * whose needs on it are open then too (so up to two deliveries can be owed). For a three-round cell the print must also rise in round 2. A fixed search,
 * so the same seed comes back every time.
 */
const SETUPS = new Map<boolean, BatterySetup>();
export function findBatterySetup(sixRound: boolean): BatterySetup {
  const known = SETUPS.get(sixRound);
  if (known !== undefined) return known;
  const found = searchBatterySetup(sixRound);
  SETUPS.set(sixRound, found);
  return found;
}

function searchBatterySetup(sixRound: boolean): BatterySetup {
  const params = sixRound ? SIX_ROUND_PARAMS : DEFAULT_PARAMS;
  const atRound = sixRound ? 5 : 2;
  for (let seed = 1; seed <= 5_000; seed++) {
    const economy = buildEconomy(seed, params);
    if (!sixRound) {
      const path = buildPrintPath(seed, printNano(PROBE_PRINT), params, "print-illustrative");
      if (!(path.byRound[1] > path.byRound[0])) continue;
    }
    for (const me of LAB_TRADERS) {
      const mine = needsOf(economy, me);
      if (mine.length !== 2 || !mine.every((n) => n.round <= atRound)) continue;
      // The first need has to be a round-1 need in the three-round cells (the history cells pay it in round 1).
      if (!sixRound && mine[0].round !== 1) continue;
      const buyers = economy.needs.filter((n) => n.seller === me && n.round <= atRound).map((n) => n.buyer);
      if (new Set(buyers).size < 2) continue;
      return { seed, rounds: params.rounds, atRound, me, needA: mine[0], needB: mine[1], buyers: [...new Set(buyers)] };
    }
  }
  throw new Error("no seed in 1..5000 gives the battery's cells what they need");
}

/** The print in each round of a trend cell, from round 1's print: +15% or -15% a step (the lab's own step), or flat. */
export function trendPath(trend: "rising" | "falling" | "flat", p1: bigint, rounds: number): PrintPath {
  const byRound: bigint[] = [p1];
  for (let r = 2; r <= rounds; r++) {
    const prev = byRound[r - 2];
    byRound.push(trend === "flat" ? prev : trend === "rising" ? stepUp(prev, STEP_BPS) : stepDown(prev, STEP_BPS));
  }
  return { byRound, ids: byRound.map((_, i) => printIdOfRound(i + 1, "print-illustrative")) };
}

export interface CellScreen {
  id: CellId;
  /** Arm A: the lab's own turn prompt, unchanged. Arms B and C are made from it by `armPrompt`. */
  prompt: string;
  trader: TraderLabel;
  seed: number;
  round: number;
  printByRound: string[];
  held: { usdcMinor: bigint; fsiuMilliSiu: bigint };
  /** The request ids the cell's quote(s) to pay carry. */
  quoteRequestId: string;
  /** Every way this cell's state differs from the lab's own rendering, stated, for the file the runner saves. */
  notes: string[];
}

const edit = (text: string, from: string | RegExp, to: string, what: string): string => {
  const count = typeof from === "string" ? text.split(from).length - 1 : (text.match(new RegExp(from.source, from.flags.includes("g") ? from.flags : `${from.flags}g`)) ?? []).length;
  if (count !== 1) throw new Error(`probe battery: expected exactly one ${what} to edit, found ${count}`);
  return text.replace(from, to);
};

/** The sentence P7 removes, and the one P8 adds to the score paragraph. */
export const NEUTRALITY_SENTENCE = /\s*Valued at the current print, converting between the two assets changes nothing about your result, and you\s+are never required to convert\./;
export const EXPIRY_SCORING_SENTENCE = " Any fSIU you still hold when the window closes has expired and counts for nothing in your result.";

const PAY_TOOL_INTERNAL: Readonly<Record<PayTool, ToolName>> = { pay_with_usdc: "pay", pay_with_held_claim: "transfer_claim", pay_split: "settle_split_held" };

/** The loop's tool list with the three payment tools in the order of the route order, in the positions they already occupy. */
export function toolListFor(order: RouteOrder): readonly ToolName[] {
  const pay = new Set<ToolName>(Object.values(PAY_TOOL_INTERNAL));
  const wanted = order.tools.map((t) => PAY_TOOL_INTERNAL[t]);
  let i = 0;
  return LAB_TRADER_TOOLS.map((t) => (pay.has(t) ? wanted[i++] : t));
}

const quoteBodyFor = (siu: string, p: bigint, sellerId: string, model: string): QuoteBody =>
  buildQuoteBody(
    { siu, model, rateUsdPerSiu: printRate(p), indexVersion: "SIU-2026a", printId: "print-illustrative", printHash: "0x00", sellerId, chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed" },
    LAB_QUOTE_PRECISION,
  );

/** A fixed, plainly illustrative transaction hash for the one history line a history cell shows. Not a real transaction. */
const ILLUSTRATIVE_TX = `0x${sha256("probe-battery-illustrative-tx")}`;

export function buildCellScreen(id: CellId): CellScreen {
  const v = VARIATION[id];
  const sixRound = v.trend !== undefined;
  const params = sixRound ? SIX_ROUND_PARAMS : DEFAULT_PARAMS;
  const setup = findBatterySetup(sixRound);
  const economy: Economy = buildEconomy(setup.seed, params);
  const p1 = printNano(PROBE_PRINT);
  const path = sixRound ? trendPath(v.trend!, p1, params.rounds) : buildPrintPath(setup.seed, p1, params, "print-illustrative");
  const ids = {
    traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t.replace("-", "")}`])) as Record<TraderLabel, string>,
    issuer: "erc8004:0xISSUERB",
  };
  const books = new LabBooks(economy, ids, path);
  const guard = {
    get printNano(): bigint {
      return books.currentPrint()!;
    },
    params,
  };
  const svc = new LabService({ books, guard, seed: setup.seed, executorFor: () => referenceExecutor, tokenId: "777", order: v.order });
  const board = labQuoteBoard(svc);
  const notes: string[] = [];
  const me = setup.me;
  const history: ToolCallRecord[] = [];

  const post = (buyer: TraderLabel, sellerLabel: TraderLabel, round: number, pay: boolean): string => {
    const sellerId = ids.traders[sellerLabel];
    const body = quoteBodyFor("1.2", path.byRound[round - 1], sellerId, `model-of-${sellerLabel}`);
    const req = board.postRequest(SEAT_OF[buyer], body);
    books.requestPosted(req.requestId, buyer, sellerLabel);
    const quote = { ...body, expiry: "2026-10-08T12:00:00Z", print_id: printIdOfRound(round, "print-illustrative") } as unknown as TouchstoneQuote;
    board.postIssuedQuote(req.requestId, quote);
    books.quoteIssued(req.requestId);
    if (pay) {
      board.recordPaid(req.requestId, "usdc");
      books.paid(req.requestId, "usdc");
    }
    return req.requestId;
  };

  // The trader's first need is already bought and met in every cell (D62): left open and unquoted, it was the action haiku took in 24 of 24 pilot replies,
  // so no baseline reply was ever a payment. It paid for it in USDC at that round's print, which is why its wallet is the opening wallet less that payment.
  const sellerA = setup.needA.seller;
  for (let r = 1; r < setup.needA.round; r++) books.advanceRound();
  const bodyA = quoteBodyFor("1.2", path.byRound[setup.needA.round - 1], ids.traders[sellerA], `model-of-${sellerA}`);
  const ridA = post(me, sellerA, setup.needA.round, true);
  books.attempted(ridA, true);
  const earlierPaymentUsdc = quoteTerms("trade", path.byRound[setup.needA.round - 1], params).minorUnits;
  notes.push(
    `need A (${setup.needA.type} from ${sellerA}, round ${setup.needA.round}) is already bought and met, paid in USDC (${earlierPaymentUsdc} minor units, ${ridA}); the wallet is the opening wallet less that payment; with it open and unquoted, haiku never paid in the pilot (D62)`,
  );
  if (v.history) {
    history.push(
      {
        turn: 1,
        jobId: "probe",
        toolName: "request_quote",
        args: { siu: "1.2", model: `model-of-${sellerA}`, rateUsdPerSiu: printRate(path.byRound[setup.needA.round - 1]), indexVersion: "SIU-2026a", printId: "print-illustrative", printHash: "0x00", sellerId: ids.traders[sellerA], chain: "base-sepolia", expiresInSeconds: 3600, pattern: "fixed" },
        result: { ...bodyA, expiry: "2026-10-08T12:00:00Z", print_id: "print-illustrative" },
      },
      { turn: 2, jobId: "probe", toolName: "pay_with_usdc", args: { requestId: ridA }, result: { txHash: ILLUSTRATIVE_TX } },
    );
    notes.push(
      `history: those two turns are shown in the lab's own format, the quote request and ${ridA} paid in USDC; the payment line is followed by the agent's stated reason "${EARMARK_REASON}", which the lab does not show; the tx hash is a fixed illustrative value, not a transaction`,
    );
  }

  for (let r = setup.needA.round; r < setup.atRound; r++) books.advanceRound();

  // Deliveries owed to the trader: raw work still to buy. Each is a buyer's open need on it, paid in USDC.
  const owedBuyers = setup.buyers.filter((b) => b !== me).slice(0, v.owed);
  for (const buyer of owedBuyers) {
    post(buyer, me, setup.atRound, true);
  }
  if (owedBuyers.length !== v.owed) throw new Error(`cell ${id}: the seed gives only ${owedBuyers.length} buyers`);

  // The quote in front: the trader's later need, asked for and quoted at this round's print.
  const quoteRequestId = post(me, setup.needB.seller, setup.atRound, false);

  const pNow = path.byRound[setup.atRound - 1];
  const reachable = reachablePrints(p1, params);
  const openingFsiu = openingMilliSiuPerTrader(params);
  const openingUsdc = openingUsdcMinor(reachable, params);

  let held = { usdcMinor: openingUsdc - earlierPaymentUsdc, fsiuMilliSiu: openingFsiu };
  if (v.wallet !== "opening") {
    const total = held.usdcMinor + milliSiuAsUsdcMinor(held.fsiuMilliSiu, pNow);
    const heavy = (total * WEIGHT_PERMILLE) / 1000n;
    const light = total - heavy;
    held = v.wallet === "usdc" ? { usdcMinor: heavy, fsiuMilliSiu: usdcMinorAsMilliSiu(light, pNow) } : { usdcMinor: light, fsiuMilliSiu: usdcMinorAsMilliSiu(heavy, pNow) };
    notes.push(`wallet: ${v.wallet === "usdc" ? "80% USDC, 20% fSIU" : "20% USDC, 80% fSIU"} of the opening wallet's total value at this round's print (${total} USDC minor units)`);
  }
  // Both assets must be able to pay the quote in front of the trader (§14.5).
  const job = quoteTerms("trade", pNow, params);
  if (held.usdcMinor < job.minorUnits || held.fsiuMilliSiu < job.milliSiu) {
    throw new Error(`cell ${id}: a wallet cannot pay the quote in either asset (${held.usdcMinor} USDC minor units, ${held.fsiuMilliSiu} mSIU against ${job.minorUnits} and ${job.milliSiu})`);
  }
  if (priceMilliSiu("trade", params) !== job.milliSiu) throw new Error("quote price drifted from the lab's own price");

  let brief = buildLabBrief({
    me,
    economy,
    print: { printId: "print-illustrative", rateUsdPerSiu: PROBE_PRINT },
    opening: { fsiuMilliSiu: openingFsiu, usdcMinor: openingUsdc },
    order: v.order,
    address: `0x${"ab".repeat(20)}`,
    directory: {
      ...Object.fromEntries(LAB_TRADERS.map((t) => [t, { sellerId: ids.traders[t], model: `model-of-${t}` }])),
      ISSUER: { sellerId: ids.issuer, model: "raw-work" },
    } as Parameters<typeof buildLabBrief>[0]["directory"],
    claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-08 10:00:00", untilIso: "2026-10-08 10:25:00" },
    maxTurns: 40,
    chain: "base-sepolia",
  });
  if (v.dropNeutrality) {
    brief = edit(brief, NEUTRALITY_SENTENCE, "", "neutrality sentence");
    notes.push("the sentence \"Valued at the current print, converting between the two assets changes nothing about your result, and you are never required to convert.\" is removed from the brief");
  }
  if (v.expiryScoring) {
    brief = edit(brief, /(and you\s+are never required to convert\.)/, `$1${EXPIRY_SCORING_SENTENCE}`, "end of the score paragraph");
    notes.push(`counterfactual: the sentence "${EXPIRY_SCORING_SENTENCE.trim()}" is added after the score paragraph. The lab measures results before the window closes and does not state this; the neutrality sentence stays, so the screen is partly at odds with itself, which is the point of reading what the agent does with it`);
  }
  if (v.order !== FIXED_ROUTE_ORDER) notes.push("fSIU is named first wherever the lab names both assets, and the three payment routes and their tool descriptions are listed fSIU route first");
  if (sixRound) notes.push(`six-round lab, screen at round ${setup.atRound}, ${v.trend} prints: ${path.byRound.slice(0, setup.atRound).map(String).join(" → ")} nano-USD per SIU; no history shown; the opening is sized by the lab's own rule for a six-round lab`);
  if (v.owed === 0) notes.push("the trader owes no delivery, so it has no raw work still to buy");
  else notes.push(`the trader has been paid for ${v.owed} job${v.owed === 1 ? "" : "s"} and holds no unit of raw work, so ${v.owed} unit${v.owed === 1 ? "" : "s"} of raw work ${v.owed === 1 ? "is" : "are"} still to buy`);

  const sections = composeBoard(
    {
      marketBoardText: board.renderFor(SEAT_OF[me], ids.traders[me]),
      redemptionText: "",
      transferText: "",
      deliveryOwedText: "",
      settleableText: "",
      servedText: "",
      servedWasFailure: false,
      unservedText: "",
      lapsingText: "",
      deliveredGateText: "",
      gateDefeatedText: "",
      forwardInvitation: "",
      labInfoText: renderLabInfo(books, { printNano: pNow, params }, me, { order: v.order, held }),
      labActionText: renderLabAction(books, me),
    },
    LAB_TRADER_TOOLS,
  ).shown;

  let prompt = buildTurnPrompt(assembleContext(SEAT_OF[me], brief, history), toolListFor(v.order), sections, (t) => LAB_TOOL_DESCRIPTIONS[t]);
  if (v.history) {
    prompt = edit(prompt, /(Turn 2 — called pay_with_usdc\(\{[^\n]*\) -> \{"txHash":"0x[0-9a-f]+"\})/, `$1 — your reason then: "${EARMARK_REASON}"`, "payment history line");
  }
  return { id, prompt, trader: me, seed: setup.seed, round: setup.atRound, printByRound: path.byRound.slice(0, setup.atRound).map(String), held, quoteRequestId, notes };
}

/** The lab's own reply-format paragraph about the optional one-line rationale, exactly as `loop/prompt.ts` writes it. */
export const RATIONALE_PARAGRAPH = `You may also add a "rationale" field to that same object: one line, in your own words.
{"tool": "<tool_name>", "args": {...}, "rationale": "<one line>"}
It is available on every call and on {"done": true}. Omit it if you have nothing to add.`;

/** Arm B's one changed paragraph (§14.3): the object begins with a "reasoning" field, written before the tool is chosen. */
export const REASONING_PARAGRAPH = `Begin that same object with a "reasoning" field, written BEFORE you choose the tool: a few sentences, in your own words, on why you are choosing what you are about to choose. Then the call.
{"reasoning": "<a few sentences>", "tool": "<tool_name>", "args": {...}}
It is available on every call and on {"done": true}.`;

/** Arm A and arm C show the lab's own prompt; arm B swaps the one paragraph. Throws if the paragraph is not there exactly once. */
export function armPrompt(prompt: string, arm: Arm): string {
  return arm === "B" ? edit(prompt, RATIONALE_PARAGRAPH, REASONING_PARAGRAPH, "rationale paragraph") : prompt;
}

export type Route = "usdc" | "fsiu" | "split";
export type Outcome = "payment" | "not_payment" | "unparsed";

export interface ParsedReply {
  outcome: Outcome;
  route?: Route;
  /** The tool the reply named, as written. */
  tool?: string;
  /** The stated reason: the `reasoning` field in arm B, the `rationale` line in arms A and C. Undefined when absent or blank. */
  statedReason?: string;
}

const ROUTE_OF: Readonly<Record<string, Route>> = { pay_with_usdc: "usdc", pay_with_held_claim: "fsiu", pay_split: "split" };

/** Reads one reply with the lab's own parser, then the arm's reason field. A reply that is not a tool call is `not_payment`; one that does not parse is `unparsed`. */
export function parseBatteryReply(text: string, arm: Arm): ParsedReply {
  let intent: ReturnType<typeof parseModelResponse>;
  try {
    intent = parseModelResponse(text);
  } catch {
    return { outcome: "unparsed" };
  }
  const reasoning = arm === "B" ? reasoningField(text) : undefined;
  const statedReason = arm === "B" ? reasoning : intent.rationale;
  const reason = statedReason === undefined ? {} : { statedReason };
  if (!("tool" in intent)) return { outcome: "not_payment", ...reason };
  const route = ROUTE_OF[intent.tool];
  return route === undefined ? { outcome: "not_payment", tool: intent.tool, ...reason } : { outcome: "payment", route, tool: intent.tool, ...reason };
}

/** The `reasoning` string of the first JSON object in a reply, if it has one that is not blank. */
function reasoningField(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const o = JSON.parse(text.slice(start, end + 1)) as { reasoning?: unknown };
      return typeof o.reasoning === "string" && o.reasoning.trim() !== "" ? o.reasoning.trim() : undefined;
    } catch {
      /* try a shorter span */
    }
  }
  return undefined;
}
