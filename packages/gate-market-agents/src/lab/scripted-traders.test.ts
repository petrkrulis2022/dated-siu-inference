import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import { assembleContext, type ToolCallRecord } from "../context/assemble.js";
import { composeBoard } from "../loop/full-run.js";
import { buildTurnPrompt } from "../loop/prompt.js";
import { QuoteBoard } from "../loop/quote-board.js";
import { requestQuoteTool } from "../tools/request-quote.js";
import { renderLabAction, renderLabInfo } from "./board.js";
import { LabBooks } from "./books.js";
import { buildLabBrief } from "./briefs.js";
import { DEFAULT_PARAMS, LAB_TRADERS, SEAT_OF, buildEconomy, type TraderLabel } from "./economy.js";
import { guardLabCall } from "./guards.js";
import {
  claimTokenId,
  deliveredIn,
  directoryOf,
  historyOf,
  holdingsShown,
  myAddress,
  openNeeds,
  owedJobs,
  printInForce,
  receivedQuotes,
  unitsHeld,
  whoAmI,
} from "./lab-cues.js";
import { priceMilliSiu, printNano, printRate } from "./money.js";
import { LabService, labQuoteBoard } from "./service.js";
import { referenceExecutor } from "./jobs.js";
import { LAB_TRADER_TOOLS } from "./roster.js";
import { buildPrintPath } from "./prints.js";
import { LAB_TOOL_DESCRIPTIONS } from "./tools.js";
import {
  JOB_ROUTES,
  RAW_ROUTES,
  decide,
  newMemory,
  plannedJobRoute,
  plannedRawRoute,
  scriptedLabTraders,
  type Memory,
  type ScriptedLabEnv,
} from "./scripted-traders.js";

const economy = buildEconomy(9);
/**
 * The board exactly as the runner builds it: a requester is shown by its label, never its seat, and each request and quote reads as the lab writes it,
 * in SIU (D50), from the books the lab keeps (`LabService.describeRequest`, `describeQuote`).
 */
const boardFor = (books: LabBooks, guard: { readonly printNano: bigint; params: typeof DEFAULT_PARAMS } = { printNano: p, params: DEFAULT_PARAMS }): QuoteBoard => {
  return labQuoteBoard(new LabService({ books, guard, seed: 9, executorFor: () => referenceExecutor, tokenId: "777" }));
};
const PRINT = "0.001437"; // illustrative
const p = printNano(PRINT);
const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t.replace("-", "")}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUERB",
};
const directory = {
  ...Object.fromEntries(LAB_TRADERS.map((t) => [t, { sellerId: ids.traders[t], model: `model-of-${t}` }])),
  ISSUER: { sellerId: ids.issuer, model: "raw-work" },
} as Parameters<typeof buildLabBrief>[0]["directory"];
const env: ScriptedLabEnv = {
  print: { printId: "print-illustrative", printHash: "0x00", rateUsdPerSiu: PRINT, indexVersion: "SIU-2026a" },
  params: DEFAULT_PARAMS,
  chain: "base-sepolia",
  quoteExpirySeconds: 3600,
  printNano: p,
};

/** A request or quote body as v8 states it: its siu is the price in SIU (1.2 for a job, 1 for a unit of raw work) and its rate is the print. */
const fakeBody = (sellerId: string, kind: "trade" | "rawwork" = "trade"): QuoteBody =>
  ({
    schema_version: "2.0",
    siu: kind === "trade" ? "1.2" : "1",
    pattern: "fixed",
    model: "m",
    rate_usd_per_siu: PRINT,
    amount_usd_max: kind === "trade" ? "0.001725" : "0.001437",
    seller_id: sellerId,
  }) as unknown as QuoteBody;
const fakeQuote = (sellerId: string, kind: "trade" | "rawwork" = "trade"): TouchstoneQuote =>
  ({ ...fakeBody(sellerId, kind), print_id: "print-illustrative", expiry: "2026-10-06T11:00:00Z", settlement: [{ amount_max: kind === "trade" ? "1725" : "1437" }] }) as unknown as TouchstoneQuote;

/**
 * A request, answered, on the board AND in the lab's books, as the loop and the lab record them together: the board's id is the books'.
 * `buyer` asks `seller` (a trader, or the issuer) for a job or a unit of raw work; the quote is issued unless told not to.
 */
function postQuote(books: LabBooks, board: QuoteBoard, buyer: TraderLabel, seller: TraderLabel | "ISSUER", options: { issue?: boolean } = {}): string {
  const kind = seller === "ISSUER" ? "rawwork" : "trade";
  const sellerId = seller === "ISSUER" ? ids.issuer : ids.traders[seller];
  const req = board.postRequest(SEAT_OF[buyer], fakeBody(sellerId, kind));
  books.requestPosted(req.requestId, buyer, seller);
  if (options.issue !== false) {
    board.postIssuedQuote(req.requestId, fakeQuote(sellerId, kind));
    books.quoteIssued(req.requestId);
  }
  return req.requestId;
}

/** A trader's whole prompt, built by the real renderers: brief, tools, history, board, lab sections. */
function promptFor(me: TraderLabel, books: LabBooks, board: QuoteBoard, history: ToolCallRecord[] = [], guardOverride?: { readonly printNano: bigint; params: typeof DEFAULT_PARAMS }): string {
  const brief = buildLabBrief({
    me,
    economy,
    print: { printId: "print-illustrative", rateUsdPerSiu: PRINT },
    opening: { fsiuMilliSiu: 4_400n, usdcMinor: 8_364n },
    address: `0x${"ab".repeat(20)}`,
    directory,
    claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-06 10:00:00", untilIso: "2026-10-06 10:25:00" },
    maxTurns: 40,
    chain: "base-sepolia",
  });
  const guard = guardOverride ?? { printNano: p, params: DEFAULT_PARAMS };
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
      labInfoText: renderLabInfo(books, guard, me, { held: { usdcMinor: 8_364n, fsiuMilliSiu: 4_400n } }),
      labActionText: renderLabAction(books, me),
    },
    LAB_TRADER_TOOLS,
  ).shown;
  // The loop passes the lab's own descriptions for its payment tools (`LabHooks.toolDescription`); so does this.
  return buildTurnPrompt(assembleContext(SEAT_OF[me], brief, history), LAB_TRADER_TOOLS, sections, (t) => LAB_TOOL_DESCRIPTIONS[t]);
}

const call = (turn: number, toolName: string, args: unknown, result: unknown): ToolCallRecord => ({ turn, jobId: "lab", toolName, args, result });

describe("lab cues read what the lab's own renderers write", () => {
  const books = new LabBooks(economy, ids);
  const board = boardFor(books);
  // A trader with a need open in round 1; which one depends on the seed.
  const me: TraderLabel = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
  const prompt = promptFor(me, books, board);

  it("reads who the trader is, its address, the token and the directory from the brief", () => {
    expect(whoAmI(prompt)).toBe(me);
    expect(myAddress(prompt)).toBe(`0x${"ab".repeat(20)}`);
    expect(claimTokenId(prompt)).toBe("777");
    const dir = directoryOf(prompt);
    for (const t of LAB_TRADERS) expect(dir[t]).toEqual({ sellerId: ids.traders[t], model: `model-of-${t}` });
    expect(dir["ISSUER-B"]).toEqual({ sellerId: ids.issuer, model: "raw-work" });
  });

  it("reads the needs it can buy now, exactly the ones the books say are open", () => {
    const expected = books.openNeeds(me).map((n) => `${n.id}|${n.type}|${n.seller}|${n.round}`);
    expect(openNeeds(prompt).map((n) => `${n.needId}|${n.type}|${n.seller}|${n.round}`)).toEqual(expected);
    expect(expected.length).toBeGreaterThan(0);
  });

  it("reads jobs owed and the units held", () => {
    const b = new LabBooks(economy, ids);
    const need = economy.needs.find((n) => n.round === 1)!;
    b.requestPosted("qr-1", need.buyer, need.seller);
    b.paid("qr-1", "usdc");
    const text = promptFor(need.seller, b, boardFor(b));
    expect(owedJobs(text)).toEqual([{ requestId: "qr-1", type: need.type, buyer: need.buyer }]);
    expect(unitsHeld(text)).toBe(0);
  });

  it("reads quotes received in SIU, with what each costs in either asset and the print it was priced at, and the history in the loop's own format", () => {
    const b = new LabBooks(economy, ids);
    const bd = boardFor(b);
    // A buyer with a need open in round 1, and the seller of it; the unit of raw work is the same buyer's.
    const need = economy.needs.find((n) => n.round === 1)!;
    postQuote(b, bd, need.buyer, need.seller);
    postQuote(b, bd, need.buyer, "ISSUER");
    const history = [
      call(1, "request_quote", { sellerId: ids.traders["TRADER-2"] }, {}),
      call(2, "deliver_job", { requestId: "qr-9" }, { delivered: true }),
      call(3, "pay", { requestId: "qr-8" }, { error: "no" }),
    ];
    const text = promptFor(need.buyer, b, bd, history);
    expect(receivedQuotes(text)).toEqual([
      { requestId: "qr-1", seller: need.seller, kind: "job", priceSiu: "1.2", amountUsd: "0.001725", claimMilliSiu: 1_200n, printNano: p },
      { requestId: "qr-2", seller: "ISSUER-B", kind: "raw", priceSiu: "1", amountUsd: "0.001437", claimMilliSiu: 1_000n, printNano: p },
    ]);
    const parsed = historyOf(text);
    expect(parsed.map((c) => [c.turn, c.tool, c.failed])).toEqual([[1, "request_quote", false], [2, "deliver_job", false], [3, "pay", true]]);
    expect([...deliveredIn(parsed)]).toEqual(["qr-9"]);
  });

  it("reads the quote line whichever asset the run lists first", () => {
    const b = new LabBooks(economy, ids);
    const bd = boardFor(b);
    const need = economy.needs.find((n) => n.round === 1)!;
    postQuote(b, bd, need.buyer, need.seller);
    const flipped = promptFor(need.buyer, b, bd).replace("settle 0.001725 USD or 1,200 mSIU of fSIU", "settle 1,200 mSIU of fSIU or 0.001725 USD");
    expect(flipped).toContain("settle 1,200 mSIU of fSIU or 0.001725 USD");
    expect(receivedQuotes(flipped)).toHaveLength(1);
    expect(receivedQuotes(flipped)).toEqual(receivedQuotes(promptFor(need.buyer, b, bd)));
  });

  it("reads the holdings line it is shown", () => {
    expect(holdingsShown(promptFor("TRADER-1", new LabBooks(economy, ids), boardFor(new LabBooks(economy, ids))))).toEqual({ usdcMinor: 8_364n, fsiuMilliSiu: 4_400n });
    expect(holdingsShown("  YOU HOLD: 4,400 mSIU of fSIU (= 6,323 USDC minor units at this print) and 8,364 USDC minor units (= 5,820 mSIU at this print)")).toEqual({ usdcMinor: 8_364n, fsiuMilliSiu: 4_400n });
    expect(holdingsShown("nothing here")).toBeUndefined();
  });
});

describe("the route assignment", () => {
  it("uses every route for jobs and for raw work, each at least twice across four traders and two purchases each", () => {
    const jobs = LAB_TRADERS.flatMap((t) => [0, 1].map((j) => plannedJobRoute(t, j)));
    const raws = LAB_TRADERS.flatMap((t) => [0, 1].map((j) => plannedRawRoute(t, j)));
    for (const r of JOB_ROUTES) expect(jobs.filter((x) => x === r).length, r).toBeGreaterThanOrEqual(2);
    for (const r of RAW_ROUTES) expect(raws.filter((x) => x === r).length, r).toBeGreaterThanOrEqual(2);
  });

  it("pays a quote in claims by its price in SIU, which is what the quote line states: 1,200 mSIU for a job and 1,000 for a unit of raw work", () => {
    expect(priceMilliSiu("trade", DEFAULT_PARAMS)).toBe(1_200n);
    expect(priceMilliSiu("rawwork", DEFAULT_PARAMS)).toBe(1_000n);
  });
});

describe("a scripted trader's decisions", () => {
  const fresh = (): { mem: Memory; books: LabBooks; board: QuoteBoard } => {
    const books = new LabBooks(economy, ids);
    return { mem: newMemory(), books, board: boardFor(books) };
  };

  it("asks the seller of a need it can buy for a job — a request the lab's own guards and the tool accept", () => {
    const { mem, books, board } = fresh();
    const me: TraderLabel = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
    const need = books.openNeeds(me)[0];
    const { intent } = decide(promptFor(me, books, board), env, mem);
    expect(intent).toMatchObject({ tool: "request_quote", args: { sellerId: ids.traders[need.seller], siu: "1.2", rateUsdPerSiu: "0.001437", model: `model-of-${need.seller}`, pattern: "fixed" } });
    const args = (intent as { args: Record<string, unknown> }).args;
    expect(guardLabCall(books, { printNano: p, params: DEFAULT_PARAMS }, me, "request_quote", args)).toBeNull();
    expect(requestQuoteTool.argsSchema.safeParse(args).success).toBe(true);
  });

  it("answers a request addressed to it before anything else", () => {
    const { mem, books, board } = fresh();
    const need = economy.needs.find((n) => n.round === 1)!;
    const id = postQuote(books, board, need.buyer, need.seller, { issue: false });
    const { intent } = decide(promptFor(need.seller, books, board), env, mem);
    expect(intent).toEqual({ tool: "issue_quote", args: { requestId: id } });
  });

  it("waits when there is nothing to do", () => {
    const { mem, books, board } = fresh();
    const idle = LAB_TRADERS.find((t) => books.openNeeds(t).length === 0)!;
    expect(decide(promptFor(idle, books, board), env, mem).intent).toEqual({ wait: true });
  });

  describe("paying a received job quote: read the balances, then the planned route if it can be afforded", () => {
    const quoted = (route: "usdc" | "held" | "split") => {
      const s = fresh();
      // A trader with a need open in round 1 whose first job purchase is assigned this route.
      const me = LAB_TRADERS.find((t) => s.books.openNeeds(t).length > 0 && plannedJobRoute(t, 0) === route)!;
      const need = s.books.openNeeds(me)[0];
      const requestId = postQuote(s.books, s.board, me, need.seller);
      return { ...s, me, need, requestId };
    };
    /** The history after a `get_balances` at `turn` that found these funds. */
    const read = (turn: number, usdcMinor: number, fsiu: number): ToolCallRecord =>
      call(turn, "get_balances", {}, { usdc: { decimalUsd: "x", integerMinorUnits: String(usdcMinor), liveArm: "decimal" }, claims: [{ tokenId: "777", balance: String(fsiu) }], escrows: [] });
    const READ = { tool: "get_balances", args: { account: `0x${"ab".repeat(20)}`, tokenIds: ["777"] } };
    /** Reads, is shown the funds, and decides. */
    const pays = (s: ReturnType<typeof quoted>, usdc: number, fsiu: number) => {
      expect(decide(promptFor(s.me, s.books, s.board), env, s.mem).intent).toEqual(READ);
      return decide(promptFor(s.me, s.books, s.board, [read(1, usdc, fsiu)]), env, s.mem).intent;
    };

    it("reads its balances before paying by any route", () => {
      for (const route of ["usdc", "held", "split"] as const) {
        const s = quoted(route);
        expect(decide(promptFor(s.me, s.books, s.board), env, s.mem).intent, route).toEqual(READ);
      }
    });

    it("usdc: pay_with_usdc, by the quote alone", () => {
      const s = quoted("usdc");
      expect(pays(s, 10_000, 5_000)).toEqual({ tool: "pay_with_usdc", args: { requestId: s.requestId } });
      expect(s.mem.status.fellBack).toEqual([]);
    });

    it("split: half of the quote's price in mSIU from a held balance, the rest in dollars", () => {
      const s = quoted("split");
      expect(pays(s, 10_000, 5_000)).toEqual({ tool: "pay_split", args: { requestId: s.requestId, claimQuantityMilliSiu: "600" } });
    });

    it("split: needs some of each asset — it is not affordable with only one of them", () => {
      // 600 mSIU from a held balance and 863 minor units in dollars (600 mSIU is worth 862 at this print, and the quote is 1,725).
      expect(pays(quoted("split"), 10_000, 100)).toMatchObject({ tool: "pay_with_usdc" }); // too little fSIU: falls back to dollars
      expect(pays(quoted("split"), 100, 5_000)).toMatchObject({ tool: "pay_with_held_claim" }); // too few dollars: falls back to the claim
    });

    it("pays a quote by a split when its wallet straddles the two assets and neither alone would pay — the pilot's TRADER-3", () => {
      // 1,174 USDC against a 1,725 quote and 816 mSIU against a 1,200 mSIU price: neither route alone, but 600 mSIU and 863 USDC.
      const s = quoted("usdc");
      expect(pays(s, 1_174, 816)).toEqual({ tool: "pay_split", args: { requestId: s.requestId, claimQuantityMilliSiu: "600" } });
    });

    it("held: pay_with_held_claim, by the quote alone, once its balance covers the quote", () => {
      const s = quoted("held");
      expect(pays(s, 10_000, 2_000)).toEqual({ tool: "pay_with_held_claim", args: { requestId: s.requestId } });
      expect(s.mem.status.fellBack).toEqual([]);
    });

    it("falls back to dollars when the planned route's price is in fSIU it does not hold, and says so", () => {
      const s = quoted("held");
      expect(pays(s, 10_000, 100)).toEqual({ tool: "pay_with_usdc", args: { requestId: s.requestId } });
      expect(s.mem.status.fellBack).toEqual([
        { trader: s.me, requestId: s.requestId, planned: "held", because: "holds 10000 USDC minor units and 100 mSIU; the quote is 1725 and 1200 mSIU" },
      ]);
    });

    it("pays in claims it holds when it has no dollars for the quote", () => {
      const s = quoted("usdc");
      expect(pays(s, 500, 2_000)).toMatchObject({ tool: "pay_with_held_claim" });
    });

    it("prefers a route the walk has used least over the planned one when it can afford both — coverage is the aim", () => {
      const s = quoted("usdc");
      // Two jobs have already gone by dollars; nothing by the other routes.
      for (const id of ["qr-90", "qr-91"]) s.mem.status.decided.push({ trader: "TRADER-9" as never, requestId: id, kind: "job", planned: "usdc", used: "usdc" });
      const intent = pays(s, 10_000, 5_000) as { tool: string };
      expect(intent.tool).not.toBe("pay_with_usdc");
      expect(["pay_with_held_claim", "pay_split"]).toContain(intent.tool);
      // Dollars were affordable, so this is a choice for coverage and not a fall back.
      expect(s.mem.status.fellBack).toEqual([]);
    });

    it("waits, and records that it could not afford the quote, when no route is affordable", () => {
      const s = quoted("usdc");
      expect(pays(s, 10, 10)).toEqual({ wait: true });
      expect(s.mem.status.unaffordable).toEqual([
        { trader: s.me, requestId: s.requestId, usdcMinor: "10", fsiuMilliSiu: "10", needsMinor: "1725", needsMilliSiu: "1200" },
      ]);
    });

    it("sets a route aside once it has failed and reads the balances again — a failed payment is not repeated", () => {
      const s = quoted("usdc");
      expect(pays(s, 10_000, 5_000)).toMatchObject({ tool: "pay_with_usdc" });
      // The payment reverted (history: a failed `pay_with_usdc` after the read), and the quote is still on the board.
      const failed = call(3, "pay_with_usdc", {}, { error: "the paying wallet does not hold enough USDC." });
      const again = decide(promptFor(s.me, s.books, s.board, [read(1, 10_000, 5_000), failed]), env, s.mem).intent;
      expect(again).toEqual(READ);
      const next = decide(promptFor(s.me, s.books, s.board, [read(1, 10_000, 5_000), failed, read(5, 10_000, 5_000)]), env, s.mem).intent;
      expect(next).toMatchObject({ tool: "pay_with_held_claim" }); // dollars are set aside; the next affordable route is the held claim
      expect(s.mem.status.decided).toHaveLength(1);
      expect(s.mem.status.decided[0]).toMatchObject({ planned: "usdc", used: "held" });
    });
  });

  describe("as the seller of a paid job", () => {
    const paidJob = (units = 0) => {
      const s = fresh();
      const need = economy.needs.find((n) => n.round === 1)!;
      s.books.requestPosted("qr-1", need.buyer, need.seller);
      s.books.quoteIssued("qr-1");
      s.books.paid("qr-1", "usdc");
      // Units the seller already holds: buy and pay for as many raw-work units.
      for (let i = 0; i < units; i++) {
        s.books.requestPosted(`qr-raw${i}`, need.seller, "ISSUER");
        s.books.paid(`qr-raw${i}`, "usdc");
      }
      return { ...s, need };
    };

    it("buys a unit of raw work from the issuer when it holds none, at the print", () => {
      const s = paidJob(0);
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board), env, s.mem);
      expect(intent).toMatchObject({ tool: "request_quote", args: { sellerId: ids.issuer, siu: "1", rateUsdPerSiu: "0.001437", model: "raw-work" } });
      const args = (intent as { args: Record<string, unknown> }).args;
      expect(guardLabCall(s.books, { printNano: p, params: DEFAULT_PARAMS }, s.need.seller, "request_quote", args)).toBeNull();
    });

    it("does not ask for a second unit while one is ordered and unpaid", () => {
      const s = paidJob(0);
      const asked = call(1, "request_quote", { sellerId: ids.issuer }, {});
      s.books.requestPosted("qr-2", s.need.seller, "ISSUER");
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board, [asked]), env, s.mem);
      // It may have a need of its own to ask for; what it must not do is order a second unit from the issuer.
      expect(intent).not.toMatchObject({ tool: "request_quote", args: { sellerId: ids.issuer } });
    });

    it("pays the issuer's quote by the raw-work route the assignment gives", () => {
      const s = paidJob(0);
      postQuote(s.books, s.board, s.need.seller, "ISSUER");
      const route = plannedRawRoute(s.need.seller, 0);
      // It reads its balances first, then pays by the planned route.
      expect(decide(promptFor(s.need.seller, s.books, s.board), env, s.mem).intent).toMatchObject({ tool: "get_balances" });
      const funds = call(1, "get_balances", {}, { usdc: { integerMinorUnits: "10000" }, claims: [{ tokenId: "777", balance: "5000" }], escrows: [] });
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board, [funds]), env, s.mem);
      const expectedTool = { usdc: "pay_with_usdc", held: "pay_with_held_claim", split: "pay_split" }[route];
      expect(intent).toMatchObject({ tool: expectedTool });
    });

    it("delivers once it holds a unit", () => {
      const s = paidJob(1);
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board), env, s.mem);
      expect(intent).toEqual({ tool: "deliver_job", args: { requestId: "qr-1" } });
    });

    it("delivers a job paid in dollars and then has nothing to release: every payment reached it when it was made (D30)", () => {
      const s = paidJob(1);
      const req = { requestId: postQuote(s.books, s.board, s.need.buyer, s.need.seller) };
      s.board.recordPaid(req.requestId, "usdc");
      // Paid and not delivered: it delivers (it holds a unit).
      expect(decide(promptFor(s.need.seller, s.books, s.board), env, s.mem).intent).toMatchObject({ tool: "deliver_job" });
      // Delivered: the board no longer tells it about an escrow, and it never calls settle_escrow.
      const delivered = call(2, "deliver_job", { requestId: req.requestId }, { delivered: true });
      s.books.attempted("qr-1", true);
      const after = promptFor(s.need.seller, s.books, s.board, [delivered]);
      expect(after).not.toMatch(/escrow|YOU HAVE BEEN PAID/i);
      expect(JSON.stringify(decide(after, env, s.mem).intent)).not.toContain("settle_escrow");
    });
  });

  it("gives every trader its own adapter state in one shared object, and exposes what it decided", () => {
    const traders = scriptedLabTraders(env);
    expect(Object.keys(traders.adapters)).toEqual([...LAB_TRADERS]);
    expect(traders.status()).toEqual({ decided: [], fellBack: [], unaffordable: [] });
  });

  describe("a print that moves between rounds (D41)", () => {
    const path = buildPrintPath(9, p, DEFAULT_PARAMS, "print-illustrative");
    // A prompt built by the real renderers, with the books' print path, so it carries THE PRINT as a trader reads it.
    const movingPrompt = (round: number, me: TraderLabel, extra?: (b: LabBooks) => void): string => {
      const b = new LabBooks(economy, ids, path);
      for (let i = 1; i < round; i++) b.advanceRound();
      extra?.(b);
      const guard = {
        get printNano(): bigint {
          return b.currentPrint()!;
        },
        params: DEFAULT_PARAMS,
      };
      return promptFor(me, b, boardFor(b, guard), [], guard);
    };

    it("reads the print in force from THE PRINT in the prompt: round 1's in round 1, the latest after a move", () => {
      expect(printInForce(movingPrompt(1, "TRADER-1"))).toBe(path.byRound[0]);
      expect(printInForce(movingPrompt(2, "TRADER-1"))).toBe(path.byRound[1]);
      expect(printInForce(movingPrompt(3, "TRADER-1"))).toBe(path.byRound[2]);
    });

    it("reads none from a prompt that states none, and is not fooled by a needs line that starts the same way", () => {
      expect(printInForce("nothing here")).toBeUndefined();
      expect(printInForce("  Round 2: TRADER-1 needs TYPE-3 from TRADER-2 (not yet open).")).toBeUndefined();
    });

    it("asks for a job at its price in SIU and the print of the round in force as the rate, as the guard will insist", () => {
      for (const round of [1, 2, 3]) {
        const mem = newMemory();
        const buyer = LAB_TRADERS.find((t) => {
          const b = new LabBooks(economy, ids, path);
          for (let i = 1; i < round; i++) b.advanceRound();
          return b.openNeeds(t).length > 0;
        })!;
        const prompt = movingPrompt(round, buyer);
        const { intent } = decide(prompt, env, mem);
        expect(intent, `round ${round}`).toMatchObject({ tool: "request_quote", args: { siu: "1.2", rateUsdPerSiu: printRate(path.byRound[round - 1]) } });
        const b = new LabBooks(economy, ids, path);
        for (let i = 1; i < round; i++) b.advanceRound();
        const args = (intent as { args: Record<string, unknown> }).args;
        expect(
          guardLabCall(b, { printNano: path.byRound[round - 1], params: DEFAULT_PARAMS }, buyer, "request_quote", args),
          `round ${round}`,
        ).toBeNull();
      }
    });
  });
});
