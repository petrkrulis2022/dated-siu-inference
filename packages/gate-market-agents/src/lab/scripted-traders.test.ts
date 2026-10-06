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
import { DEFAULT_PARAMS, LAB_TRADERS, SEAT_OF, buildEconomy, labDisplayName, type TraderLabel } from "./economy.js";
import { guardLabCall } from "./guards.js";
import {
  claimTokenId,
  deliveredIn,
  directoryOf,
  historyOf,
  myAddress,
  openNeeds,
  owedJobs,
  receivedQuotes,
  unitsHeld,
  whoAmI,
} from "./lab-cues.js";
import { jobSiu, printNano, rawWorkRateUsdPerSiu, tradeRateUsdPerSiu } from "./money.js";
import { LAB_TRADER_TOOLS } from "./roster.js";
import {
  JOB_ROUTES,
  RAW_ROUTES,
  claimFor,
  decide,
  newMemory,
  plannedJobRoute,
  plannedRawRoute,
  scriptedLabTraders,
  type Memory,
  type ScriptedLabEnv,
} from "./scripted-traders.js";

const economy = buildEconomy(9);
/** The board exactly as the runner builds it: a requester is shown by its label, never its seat. */
const PRODUCTION_BOARD = { reservationStep: false, displayName: labDisplayName } as const;
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
  rates: { trade: tradeRateUsdPerSiu(p, DEFAULT_PARAMS), raw: rawWorkRateUsdPerSiu(p) },
  sizeSiu: jobSiu(DEFAULT_PARAMS),
  chain: "base-sepolia",
  quoteExpirySeconds: 3600,
  printNano: p,
};

const fakeBody = (sellerId: string, amount: string): QuoteBody =>
  ({ schema_version: "2.0", siu: "1", pattern: "fixed", model: "m", rate_usd_per_siu: "0.0017244", amount_usd_max: amount, seller_id: sellerId }) as unknown as QuoteBody;
const fakeQuote = (sellerId: string, amount: string): TouchstoneQuote =>
  ({ ...fakeBody(sellerId, amount), print_id: "print-illustrative", settlement: [{ amount_max: "0" }] }) as unknown as TouchstoneQuote;

/** A trader's whole prompt, built by the real renderers: brief, tools, history, board, lab sections. */
function promptFor(me: TraderLabel, books: LabBooks, board: QuoteBoard, history: ToolCallRecord[] = []): string {
  const brief = buildLabBrief({
    me,
    economy,
    print: { printId: "print-illustrative", rateUsdPerSiu: PRINT },
    address: `0x${"ab".repeat(20)}`,
    directory,
    claim: { tokenId: "777", classLabel: "extract", fromIso: "2026-10-06 10:00:00", untilIso: "2026-10-06 10:25:00" },
    maxTurns: 40,
    chain: "base-sepolia",
  });
  const guard = { printNano: p, params: DEFAULT_PARAMS };
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
      labInfoText: renderLabInfo(books, guard, me),
      labActionText: renderLabAction(books, me),
    },
    LAB_TRADER_TOOLS,
  ).shown;
  return buildTurnPrompt(assembleContext(SEAT_OF[me], brief, history), LAB_TRADER_TOOLS, sections);
}

const call = (turn: number, toolName: string, args: unknown, result: unknown): ToolCallRecord => ({ turn, jobId: "lab", toolName, args, result });

describe("lab cues read what the lab's own renderers write", () => {
  const books = new LabBooks(economy, ids);
  const board = new QuoteBoard(PRODUCTION_BOARD);
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
    const text = promptFor(need.seller, b, new QuoteBoard(PRODUCTION_BOARD));
    expect(owedJobs(text)).toEqual([{ requestId: "qr-1", type: need.type, buyer: need.buyer }]);
    expect(unitsHeld(text)).toBe(0);
  });

  it("reads quotes received with their amounts, and the history in the loop's own format", () => {
    const bd = new QuoteBoard(PRODUCTION_BOARD);
    const req = bd.postRequest("ORCHESTRATOR", fakeBody(ids.traders["TRADER-2"], "0.0017"));
    bd.postIssuedQuote(req.requestId, fakeQuote(ids.traders["TRADER-2"], "0.0017"));
    const history = [
      call(1, "request_quote", { sellerId: ids.traders["TRADER-2"] }, {}),
      call(2, "deliver_job", { requestId: "qr-9" }, { delivered: true }),
      call(3, "pay", { requestId: "qr-8" }, { error: "no" }),
    ];
    const text = promptFor("TRADER-1", books, bd, history);
    expect(receivedQuotes(text)).toEqual([{ requestId: "qr-1", sellerId: ids.traders["TRADER-2"], amountUsd: "0.0017" }]);
    const parsed = historyOf(text);
    expect(parsed.map((c) => [c.turn, c.tool, c.failed])).toEqual([[1, "request_quote", false], [2, "deliver_job", false], [3, "pay", true]]);
    expect([...deliveredIn(parsed)]).toEqual(["qr-9"]);
  });
});

describe("the route assignment", () => {
  it("uses every route for jobs and for raw work, each at least twice across four traders and two purchases each", () => {
    const jobs = LAB_TRADERS.flatMap((t) => [0, 1].map((j) => plannedJobRoute(t, j)));
    const raws = LAB_TRADERS.flatMap((t) => [0, 1].map((j) => plannedRawRoute(t, j)));
    for (const r of JOB_ROUTES) expect(jobs.filter((x) => x === r).length, r).toBeGreaterThanOrEqual(2);
    for (const r of RAW_ROUTES) expect(raws.filter((x) => x === r).length, r).toBeGreaterThanOrEqual(2);
  });

  it("sizes a claim from a quote the way the loop does: the price's worth at the print, rounded up", () => {
    expect(claimFor("0.0017", p)).toBe(1184n);
    expect(claimFor("0.0014", p)).toBe(975n);
  });
});

describe("a scripted trader's decisions", () => {
  const fresh = (): { mem: Memory; books: LabBooks; board: QuoteBoard } => ({
    mem: newMemory(),
    books: new LabBooks(economy, ids),
    board: new QuoteBoard(PRODUCTION_BOARD),
  });

  it("asks the seller of a need it can buy for a job — a request the lab's own guards and the tool accept", () => {
    const { mem, books, board } = fresh();
    const me: TraderLabel = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
    const need = books.openNeeds(me)[0];
    const { intent } = decide(promptFor(me, books, board), env, mem);
    expect(intent).toMatchObject({ tool: "request_quote", args: { sellerId: ids.traders[need.seller], siu: "1", rateUsdPerSiu: "0.0017244", model: `model-of-${need.seller}`, pattern: "fixed" } });
    const args = (intent as { args: Record<string, unknown> }).args;
    expect(guardLabCall(books, { printNano: p, params: DEFAULT_PARAMS }, me, "request_quote", args)).toBeNull();
    expect(requestQuoteTool.argsSchema.safeParse(args).success).toBe(true);
  });

  it("answers a request addressed to it before anything else", () => {
    const { mem, books, board } = fresh();
    const need = economy.needs.find((n) => n.round === 1)!;
    const req = board.postRequest(SEAT_OF[need.buyer], fakeBody(ids.traders[need.seller], "0.0017"));
    const { intent } = decide(promptFor(need.seller, books, board), env, mem);
    expect(intent).toEqual({ tool: "issue_quote", args: { requestId: req.requestId } });
  });

  it("waits when there is nothing to do", () => {
    const { mem, books, board } = fresh();
    const idle = LAB_TRADERS.find((t) => books.openNeeds(t).length === 0)!;
    expect(decide(promptFor(idle, books, board), env, mem).intent).toEqual({ wait: true });
  });

  describe("paying a received job quote: read the balances, then the planned route if it can be afforded", () => {
    const quoted = (route: "usdc" | "mint_forward" | "held" | "split") => {
      const s = fresh();
      // A trader whose first job purchase is assigned this route.
      const me = LAB_TRADERS.find((t) => plannedJobRoute(t, 0) === route)!;
      const need = economy.needs.find((n) => n.buyer === me)!;
      const req = s.board.postRequest(SEAT_OF[me], fakeBody(ids.traders[need.seller], "0.0017"));
      s.board.postIssuedQuote(req.requestId, fakeQuote(ids.traders[need.seller], "0.0017"));
      return { ...s, me, need, requestId: req.requestId };
    };
    /** The history after a `get_balances` at `turn` that found these funds. */
    const read = (turn: number, usdcMinor: number, fsiu: number): ToolCallRecord =>
      call(turn, "get_balances", {}, { usdc: { decimalUsd: "x", integerMinorUnits: String(usdcMinor), liveArm: "decimal" }, claims: [{ tokenId: "777", balance: String(fsiu) }], escrows: [] });
    const READ = { tool: "get_balances", args: { account: `0x${"ab".repeat(20)}`, tokenIds: ["777"] } };
    const ZERO = "0x0000000000000000000000000000000000000000";
    /** Reads, is shown the funds, and decides. */
    const pays = (s: ReturnType<typeof quoted>, usdc: number, fsiu: number) => {
      expect(decide(promptFor(s.me, s.books, s.board), env, s.mem).intent).toEqual(READ);
      return decide(promptFor(s.me, s.books, s.board, [read(1, usdc, fsiu)]), env, s.mem).intent;
    };

    it("reads its balances before paying by any route", () => {
      for (const route of ["usdc", "mint_forward", "held", "split"] as const) {
        const s = quoted(route);
        expect(decide(promptFor(s.me, s.books, s.board), env, s.mem).intent, route).toEqual(READ);
      }
    });

    it("usdc: pay, with the zero settler", () => {
      const s = quoted("usdc");
      expect(pays(s, 10_000, 5_000)).toEqual({ tool: "pay", args: { requestId: s.requestId, settler: ZERO } });
      expect(s.mem.status.fellBack).toEqual([]);
    });

    it("mint_forward: pay_with_claim", () => {
      const s = quoted("mint_forward");
      expect(pays(s, 10_000, 5_000)).toEqual({ tool: "pay_with_claim", args: { requestId: s.requestId } });
    });

    it("split: half of the quote's claim, the rest in dollars", () => {
      const s = quoted("split");
      expect(pays(s, 10_000, 5_000)).toEqual({ tool: "settle_split", args: { requestId: s.requestId, claimQuantityMilliSiu: "592", settler: ZERO } });
    });

    it("held: passes the claim on by name, in the seller's label, once its balance covers the quote", () => {
      const s = quoted("held");
      expect(pays(s, 10_000, 2_000)).toEqual({ tool: "transfer_claim", args: { agentId: s.need.seller, tokenId: "777", requestId: s.requestId } });
      expect(s.mem.status.fellBack).toEqual([]);
    });

    it("falls back to dollars when the planned route's price is in fSIU it does not hold, and says so", () => {
      const s = quoted("held");
      expect(pays(s, 10_000, 100)).toEqual({ tool: "pay", args: { requestId: s.requestId, settler: ZERO } });
      expect(s.mem.status.fellBack).toEqual([
        { trader: s.me, requestId: s.requestId, planned: "held", because: "holds 10000 USDC minor units and 100 mSIU; the quote is 1700 and 1184 mSIU" },
      ]);
    });

    it("falls back to a held claim when the planned mint would cost more dollars than it holds — minting is paid for in USDC", () => {
      // 1,184 mSIU costs 1,701 minor units to mint at this print, more than the 1,200 held.
      const s = quoted("mint_forward");
      expect(pays(s, 1_200, 5_000)).toEqual({ tool: "transfer_claim", args: { agentId: s.need.seller, tokenId: "777", requestId: s.requestId } });
    });

    it("pays in claims it holds when it has no dollars for the quote", () => {
      const s = quoted("usdc");
      expect(pays(s, 500, 2_000)).toMatchObject({ tool: "transfer_claim" });
    });

    it("waits, and records that it could not afford the quote, when no route is affordable", () => {
      const s = quoted("usdc");
      expect(pays(s, 10, 10)).toEqual({ wait: true });
      expect(s.mem.status.unaffordable).toEqual([
        { trader: s.me, requestId: s.requestId, usdcMinor: "10", fsiuMilliSiu: "10", needsMinor: "1700", needsMilliSiu: "1184" },
      ]);
    });

    it("sets a route aside once it has failed and reads the balances again — a failed payment is not repeated", () => {
      const s = quoted("usdc");
      expect(pays(s, 10_000, 5_000)).toMatchObject({ tool: "pay" });
      // The payment reverted (history: a failed `pay` after the read), and the quote is still on the board.
      const failed = call(3, "pay", {}, { error: "the paying wallet does not hold enough USDC." });
      const again = decide(promptFor(s.me, s.books, s.board, [read(1, 10_000, 5_000), failed]), env, s.mem).intent;
      expect(again).toEqual(READ);
      const next = decide(promptFor(s.me, s.books, s.board, [read(1, 10_000, 5_000), failed, read(5, 10_000, 5_000)]), env, s.mem).intent;
      expect(next).toMatchObject({ tool: "transfer_claim" }); // dollars are set aside; the next affordable route is the held claim
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
      const raw = s.board.postRequest(SEAT_OF[s.need.seller], fakeBody(ids.issuer, "0.0014"));
      s.board.postIssuedQuote(raw.requestId, fakeQuote(ids.issuer, "0.0014"));
      const route = plannedRawRoute(s.need.seller, 0);
      // It reads its balances first, then pays by the planned route.
      expect(decide(promptFor(s.need.seller, s.books, s.board), env, s.mem).intent).toMatchObject({ tool: "get_balances" });
      const funds = call(1, "get_balances", {}, { usdc: { integerMinorUnits: "10000" }, claims: [{ tokenId: "777", balance: "5000" }], escrows: [] });
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board, [funds]), env, s.mem);
      const expectedTool = { usdc: "pay", mint_forward: "pay_with_claim", held: "transfer_claim" }[route];
      expect(intent).toMatchObject({ tool: expectedTool });
    });

    it("delivers once it holds a unit", () => {
      const s = paidJob(1);
      const { intent } = decide(promptFor(s.need.seller, s.books, s.board), env, s.mem);
      expect(intent).toEqual({ tool: "deliver_job", args: { requestId: "qr-1" } });
    });

    it("releases the dollar escrow only after the job is delivered", () => {
      const s = paidJob(1);
      const req = s.board.postRequest(SEAT_OF[s.need.buyer], fakeBody(ids.traders[s.need.seller], "0.0017"));
      s.board.postIssuedQuote(req.requestId, fakeQuote(ids.traders[s.need.seller], "0.0017"));
      s.board.recordPaid(req.requestId, "usdc");
      // Paid and not delivered: it delivers (it holds a unit); it does not release.
      expect(decide(promptFor(s.need.seller, s.books, s.board), env, s.mem).intent).toMatchObject({ tool: "deliver_job" });
      // Delivered: now it releases that escrow.
      const delivered = call(2, "deliver_job", { requestId: req.requestId }, { delivered: true });
      s.books.attempted("qr-1", true);
      expect(decide(promptFor(s.need.seller, s.books, s.board, [delivered]), env, s.mem).intent).toEqual({
        tool: "settle_escrow",
        args: { requestId: req.requestId },
      });
    });
  });

  it("gives every trader its own adapter state in one shared object, and exposes what it decided", () => {
    const traders = scriptedLabTraders(env);
    expect(Object.keys(traders.adapters)).toEqual([...LAB_TRADERS]);
    expect(traders.status()).toEqual({ decided: [], fellBack: [], unaffordable: [] });
  });
});
