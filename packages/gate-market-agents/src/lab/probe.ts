/**
 * The comprehension probe (docs/marketplace_plan.md, D54): before a v8 run, each roster model is shown the real v8 screens and asked two
 * factual questions about them, never which asset it would choose. The screens are rendered by the lab's own code — the brief, and one
 * turn's screen at a print that has moved up 15% on round 1, with a quote on the board and the trader's holdings — so what is tested is what an
 * agent will actually read. The questions, the shape of the answer and the expected answers are fixed here and in the plan, before any call.
 *
 * Expected, from the screens themselves: a unit of raw work costs MORE USDC when the print rises (its dollars are 1 SIU times the print) and
 * the SAME fSIU (it is 1,000 mSIU at every print); a quote's price does NOT change after it is issued.
 */
import { createHash } from "node:crypto";
import { assembleContext } from "../context/assemble.js";
import { composeBoard } from "../loop/full-run.js";
import { buildTurnPrompt } from "../loop/prompt.js";
import { renderLabAction, renderLabInfo } from "./board.js";
import { LabBooks } from "./books.js";
import { buildLabBrief } from "./briefs.js";
import { DEFAULT_PARAMS, LAB_TRADERS, SEAT_OF, buildEconomy, type TraderLabel } from "./economy.js";
import { openingMilliSiuPerTrader, openingUsdcMinor } from "./money.js";
import { buildPrintPath, reachablePrints } from "./prints.js";
import { LabService, labQuoteBoard } from "./service.js";
import { referenceExecutor } from "./jobs.js";
import { routeOrderFor } from "./route-order.js";
import { LAB_TRADER_TOOLS } from "./roster.js";
import { LAB_TOOL_DESCRIPTIONS } from "./tools.js";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";

/** The seed whose print goes UP 15% in round 2, so the screen shows a print that has moved up. */
export const PROBE_SEED = 9;
export const PROBE_PRINT = "0.001437"; // the illustrative round-1 print every worked example in the plan uses

export const PROBE_QUESTION_1 = "If the print rises 15%, does one unit of raw work cost more, fewer or the same USDC? And fSIU?";
export const PROBE_QUESTION_2 = "Does a quote's price change after it is issued?";

/** Appended after the screen. Enumerated answers, so a reply is read, never interpreted. */
export const PROBE_SUFFIX = `

---
A QUESTION, NOT A TURN. Do not take an action and do not reply with a tool call. Using only what is stated above, answer two factual questions about this lab.
Reply with exactly one JSON object and nothing else, in this shape:
{"print_up_15_percent": {"usdc": "more" | "fewer" | "same", "fsiu": "more" | "fewer" | "same"}, "quote_price_changes_after_issue": "yes" | "no"}
Question 1. ${PROBE_QUESTION_1}
Question 2. ${PROBE_QUESTION_2}
`;

export const EXPECTED = { usdc: "more", fsiu: "same", quoteChanges: "no" } as const;

/** The real v8 screen of a trader in round 2, after the print moved, holding its opening wallet and with a quote to pay. */
export function buildProbeScreen(): { prompt: string; trader: TraderLabel; printByRound: string[] } {
  const p = BigInt(Math.round(Number(PROBE_PRINT) * 1e9));
  const economy = buildEconomy(PROBE_SEED);
  const path = buildPrintPath(PROBE_SEED, p, DEFAULT_PARAMS, "print-illustrative");
  if (!(path.byRound[1] > path.byRound[0])) throw new Error("the probe's seed must move the print up in round 2");
  const ids = {
    traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t.replace("-", "")}`])) as Record<TraderLabel, string>,
    issuer: "erc8004:0xISSUERB",
  };
  const books = new LabBooks(economy, ids, path);
  books.advanceRound();
  const guard = {
    get printNano(): bigint {
      return books.currentPrint()!;
    },
    params: DEFAULT_PARAMS,
  };
  const order = routeOrderFor(1);
  const svc = new LabService({ books, guard, seed: PROBE_SEED, executorFor: () => referenceExecutor, tokenId: "777", order });
  const board = labQuoteBoard(svc);
  // A trader with a need open in round 2, holding a quote for it.
  const me = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
  const need = books.openNeeds(me)[0];
  const sellerId = ids.traders[need.seller];
  const p2 = path.byRound[1];
  const body = { schema_version: "2.0", siu: "1.2", pattern: "fixed", model: "m", rate_usd_per_siu: "0", amount_usd_max: "0", seller_id: sellerId } as unknown as QuoteBody;
  const req = board.postRequest(SEAT_OF[me], body);
  books.requestPosted(req.requestId, me, need.seller);
  board.postIssuedQuote(req.requestId, { ...body, print_id: "lab-scenario-round-2", expiry: "2026-10-08T12:00:00Z", settlement: [{ amount_max: "0" }] } as unknown as TouchstoneQuote);
  books.quoteIssued(req.requestId);

  const reachable = reachablePrints(p, DEFAULT_PARAMS);
  const brief = buildLabBrief({
    me,
    economy,
    print: { printId: "print-illustrative", rateUsdPerSiu: PROBE_PRINT },
    opening: { fsiuMilliSiu: openingMilliSiuPerTrader(DEFAULT_PARAMS), usdcMinor: openingUsdcMinor(reachable, DEFAULT_PARAMS) },
    order,
    address: `0x${"ab".repeat(20)}`,
    directory: {
      ...Object.fromEntries(LAB_TRADERS.map((t) => [t, { sellerId: ids.traders[t], model: `model-of-${t}` }])),
      ISSUER: { sellerId: ids.issuer, model: "raw-work" },
    } as Parameters<typeof buildLabBrief>[0]["directory"],
    claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-08 10:00:00", untilIso: "2026-10-08 10:25:00" },
    maxTurns: 40,
    chain: "base-sepolia",
  });
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
      labInfoText: renderLabInfo(books, { printNano: p2, params: DEFAULT_PARAMS }, me, {
        order,
        held: { usdcMinor: openingUsdcMinor(reachable, DEFAULT_PARAMS), fsiuMilliSiu: openingMilliSiuPerTrader(DEFAULT_PARAMS) },
      }),
      labActionText: renderLabAction(books, me),
    },
    LAB_TRADER_TOOLS,
  ).shown;
  const prompt = buildTurnPrompt(assembleContext(SEAT_OF[me], brief, []), LAB_TRADER_TOOLS, sections, (t) => LAB_TOOL_DESCRIPTIONS[t]);
  return { prompt: `${prompt}${PROBE_SUFFIX}`, trader: me, printByRound: path.byRound.map(String) };
}

export const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface ProbeAnswer {
  usdc?: string;
  fsiu?: string;
  quoteChanges?: string;
}

/** The first JSON object in a reply, read into the three answers; anything that is not one of the enumerated choices is left out, not interpreted. */
export function parseProbeAnswer(text: string): ProbeAnswer {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  let j: unknown;
  try {
    j = JSON.parse(text.slice(start, end + 1));
  } catch {
    return {};
  }
  const o = (typeof j === "object" && j !== null ? j : {}) as { print_up_15_percent?: { usdc?: unknown; fsiu?: unknown }; quote_price_changes_after_issue?: unknown };
  const pick = (v: unknown, allowed: readonly string[]): string | undefined => (typeof v === "string" && allowed.includes(v.trim().toLowerCase()) ? v.trim().toLowerCase() : undefined);
  const dir = ["more", "fewer", "same"] as const;
  return {
    ...(pick(o.print_up_15_percent?.usdc, dir) !== undefined ? { usdc: pick(o.print_up_15_percent?.usdc, dir) } : {}),
    ...(pick(o.print_up_15_percent?.fsiu, dir) !== undefined ? { fsiu: pick(o.print_up_15_percent?.fsiu, dir) } : {}),
    ...(pick(o.quote_price_changes_after_issue, ["yes", "no"]) !== undefined ? { quoteChanges: pick(o.quote_price_changes_after_issue, ["yes", "no"]) } : {}),
  };
}

export interface ProbeJudgement {
  /** Question 1, both parts right: USDC more, fSIU the same. Anything else, including no answer, is wrong. */
  printDirectionRight: boolean;
  /** Question 2 right: no. Reported; not a stop under the user's instruction. */
  quoteRight: boolean;
}

export function judge(a: ProbeAnswer): ProbeJudgement {
  return { printDirectionRight: a.usdc === EXPECTED.usdc && a.fsiu === EXPECTED.fsiu, quoteRight: a.quoteChanges === EXPECTED.quoteChanges };
}
