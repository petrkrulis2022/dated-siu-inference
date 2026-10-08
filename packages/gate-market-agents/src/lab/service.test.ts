import { beforeEach, describe, expect, it } from "vitest";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, ISSUER_SEAT, LAB_TRADERS, SEAT_OF, buildEconomy, type Economy, type TraderLabel } from "./economy.js";
import { LabService, type LabServiceDeps } from "./service.js";
import { buildPrintPath } from "./prints.js";
import { quoteTerms } from "./money.js";
import { fmt } from "./quote-text.js";
import type { WorkExecutor } from "./jobs.js";
import type { AgentId } from "../identity/resolve.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};
const pass: WorkExecutor = async () => ({ passed: true, usage: { input: 1, output: 1 }, costUsd: "0.002" });
const fail: WorkExecutor = async () => ({ passed: false, reason: "the output did not match the record", usage: { input: 1, output: 1 }, costUsd: "0.003" });

describe("LabService", () => {
  let economy: Economy;
  let books: LabBooks;
  let costs: string[];
  let rounds: number[];
  let executor: WorkExecutor;
  let svc: LabService;

  const build = (): LabService => {
    const deps: LabServiceDeps = {
      books,
      guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS },
      seed: 4,
      executorFor: () => executor,
      tokenId: "777",
      recordWorkCost: (usd) => costs.push(usd),
      onRoundOpened: async (r) => void rounds.push(r),
    };
    return new LabService(deps);
  };

  beforeEach(() => {
    economy = buildEconomy(4);
    books = new LabBooks(economy, ids);
    costs = [];
    rounds = [];
    executor = pass;
    svc = build();
  });

  const need1 = () => economy.needs.find((n) => n.round === 1)!;
  const seat = (t: TraderLabel): AgentId => SEAT_OF[t];
  const ev = (agentId: AgentId, tool: string, extra: Record<string, unknown> = {}) =>
    ({ agentId, turn: 1, tool, intentArgs: {}, builtArgs: {}, result: {}, ...extra }) as never;

  /** Takes a need all the way to paid, as the loop would report it. */
  async function payNeed(requestId: string, asset: "pay" | "transfer_claim" | "settle_split_held" = "pay") {
    const n = need1();
    await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId, result: { seller_id: ids.traders[n.seller] } }));
    await svc.afterToolCall(ev(seat(n.seller), "issue_quote", { intentArgs: { requestId } }));
    await svc.afterToolCall(ev(seat(n.buyer), asset, { intentArgs: { requestId } }));
    return n;
  }
  async function buyUnit(trader: TraderLabel, requestId: string, tool = "pay") {
    await svc.afterToolCall(ev(seat(trader), "request_quote", { requestId, result: { seller_id: ids.issuer } }));
    await svc.afterToolCall(ev(ISSUER_SEAT, "issue_quote", { intentArgs: { requestId } }));
    await svc.afterToolCall(ev(seat(trader), tool, { intentArgs: { requestId } }));
  }

  describe("following the loop's calls", () => {
    it("turns a request, an answer and a payment into a paid job, whichever asset paid", async () => {
      for (const tool of ["pay", "transfer_claim", "settle_split_held"]) {
        books = new LabBooks(economy, ids);
        svc = build();
        const n = await payNeed("qr-1", tool as never);
        expect(books.sale("qr-1")).toMatchObject({ paid: true, buyer: n.buyer, seller: n.seller });
      }
    });

    it("records the asset that paid", async () => {
      await payNeed("qr-1", "pay");
      expect(books.sale("qr-1")?.paidAsset).toBe("usdc");
    });

    it("does not count a transfer that names no quote as a payment", async () => {
      const n = need1();
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-1", result: { seller_id: ids.traders[n.seller] } }));
      await svc.afterToolCall(ev(seat(n.buyer), "transfer_claim", { intentArgs: { agentId: "WORKER-CODE", tokenId: "1", quantity: "1" } }));
      expect(books.sale("qr-1")?.paid).toBe(false);
    });

    it("credits a unit of raw work when the issuer's quote is paid", async () => {
      await buyUnit("TRADER-1", "qr-7");
      expect(books.unitsOf("TRADER-1")).toBe(1);
    });

    it("ignores the issuer's own calls except to follow its quotes, and ignores unknown seats", async () => {
      await svc.afterToolCall(ev("HEDGER", "pay", { intentArgs: { requestId: "qr-1" } }));
      await svc.afterToolCall(ev(ISSUER_SEAT, "request_quote", { requestId: "qr-2", result: { seller_id: ids.issuer } }));
      expect(books.sale("qr-1")).toBeUndefined();
      expect(books.sale("qr-2")).toBeUndefined();
    });
  });

  describe("no escrow, no fee (D30)", () => {
    it("has nothing to give back: a release the loop might still report moves nothing and records nothing", async () => {
      await svc.afterToolCall(ev("WORKER-CODE", "settle_escrow", { settledRequestId: "qr-4", result: { settledMinorUnits: "1725" } }));
      expect(svc.operatorActions).toEqual([]);
    });

    it("marks a quote paid the moment a payment is made, in any asset, with nothing left to release", async () => {
      for (const [tool, asset] of [["pay", "usdc"], ["transfer_claim", "fsiu"], ["settle_split_held", "split"]] as const) {
        books = new LabBooks(economy, ids);
        svc = build();
        await payNeed("qr-1", tool);
        expect(books.sale("qr-1")).toMatchObject({ paid: true, paidAsset: asset });
        expect(books.sale("qr-1")).not.toHaveProperty("settled");
      }
    });
  });

  describe("deliver_job", () => {
    it("delivers a paid job with a unit of raw work, meets the need and spends the unit", async () => {
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const result = (await svc.deliverJob(seat(n.seller), "qr-1")) as Record<string, unknown>;
      expect(result).toEqual({ delivered: true, requestId: "qr-1", buyer: n.buyer, unitsLeft: 0 });
      expect(books.needsMet(n.buyer)).toBe(1);
      expect(costs).toEqual(["0.002"]);
      expect(svc.workLog).toHaveLength(1);
    });

    it("keeps the unit and allows a retry when the extraction fails, up to three attempts", async () => {
      executor = fail;
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const first = (await svc.deliverJob(seat(n.seller), "qr-1")) as Record<string, unknown>;
      expect(first).toMatchObject({ delivered: false, attemptsLeft: 2 });
      expect(books.unitsOf(n.seller)).toBe(1);
      expect(books.needsMet(n.buyer)).toBe(0);
      await svc.deliverJob(seat(n.seller), "qr-1");
      await svc.deliverJob(seat(n.seller), "qr-1");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has had its 3 attempts");
      executor = pass;
    });

    it("costs what the work cost, pass or fail", async () => {
      executor = fail;
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      await svc.deliverJob(seat(n.seller), "qr-1");
      expect(costs).toEqual(["0.003"]);
    });

    it("refuses, in plain sentences, everything it should", async () => {
      const n = need1();
      const other = LAB_TRADERS.find((t) => t !== n.seller && t !== n.buyer)!;
      await expect(svc.deliverJob("ISSUER-B", "qr-1")).rejects.toThrow("only a trader delivers jobs");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("there is no request qr-1");
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-1", result: { seller_id: ids.traders[n.seller] } }));
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has not been paid yet");
      await svc.afterToolCall(ev(seat(n.buyer), "pay", { intentArgs: { requestId: "qr-1" } }));
      await expect(svc.deliverJob(seat(other), "qr-1")).rejects.toThrow("is not a job you sold");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("you hold no unit of raw work");
      await buyUnit(n.seller, "qr-2");
      await expect(svc.deliverJob(seat(n.seller), "qr-2")).rejects.toThrow("is not a job; it is a unit of raw work");
      await svc.deliverJob(seat(n.seller), "qr-1");
      await expect(svc.deliverJob(seat(n.seller), "qr-1")).rejects.toThrow("has already been delivered");
    });

    it("never puts the expected answer in what it returns", async () => {
      const n = await payNeed("qr-1");
      await buyUnit(n.seller, "qr-2");
      const out = JSON.stringify(await svc.deliverJob(seat(n.seller), "qr-1"));
      expect(out).not.toMatch(/tracking_id|origin_city|expected/);
    });
  });

  describe("rounds", () => {
    it("opens the next round and tells the runner, until there is none", async () => {
      expect(await svc.advanceRound()).toBe(true);
      expect(await svc.advanceRound()).toBe(true);
      expect(await svc.advanceRound()).toBe(false);
      expect(rounds).toEqual([2, 3]);
      expect(svc.operatorActions.filter((a) => a.kind === "round_opened")).toHaveLength(2);
    });
  });

  describe("the hooks the loop calls", () => {
    it("shows a trader the board and the issuer nothing, and refuses by the guard", async () => {
      expect(await svc.infoTextFor("ORCHESTRATOR")).toContain("THE LAB");
      expect(await svc.infoTextFor(ISSUER_SEAT)).toBe("");
      expect(svc.actionTextFor(ISSUER_SEAT)).toBe("");
      expect(await svc.guard("ORCHESTRATOR", "request_quote", { siu: "1" })).toBe("request_quote needs a sellerId.");
      expect(await svc.guard("HEDGER", "request_quote", { siu: "1" })).toBeNull();
    });
  });

  describe("what a trader is shown of its wallet and of a quote (D50)", () => {
    const OPENING = { usdcMinor: 8_364n, fsiuMilliSiu: 4_400n };
    const withOpening = (extra: Partial<LabServiceDeps> = {}): LabService =>
      new LabService({ books, guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS }, seed: 4, executorFor: () => executor, tokenId: "777", opening: OPENING, ...extra });

    it("states what the trader holds by the lab's own account, each asset in the other's terms, and records what it showed", async () => {
      const shown: { trader: string; round: number; usdc: bigint; fsiu: bigint }[] = [];
      const s = withOpening({ onHoldingsShown: (trader, round, h) => shown.push({ trader, round, usdc: h.usdcMinor, fsiu: h.fsiuMilliSiu }) });
      const text = await s.infoTextFor("ORCHESTRATOR");
      expect(text).toContain("YOU HOLD: 8,364 USDC minor units (= 5,820 mSIU at this print) and 4,400 mSIU of fSIU (= 6,323 USDC minor units at this print)");
      expect(shown).toEqual([{ trader: "TRADER-1", round: 1, usdc: 8_364n, fsiu: 4_400n }]);
    });

    it("leaves the line out, and guesses nothing, when the service was given no opening", async () => {
      expect(await svc.infoTextFor("ORCHESTRATOR")).not.toContain("YOU HOLD");
      expect(svc.walletOf("TRADER-1")).toBeUndefined();
    });

    it("does not read the chain to show a wallet: a stable read waits a block and costs every turn seconds", async () => {
      let reads = 0;
      const s = withOpening({
        holdings: async () => {
          reads++;
          return OPENING;
        },
      });
      await s.infoTextFor("ORCHESTRATOR");
      await s.infoTextFor("WORKER-CODE");
      expect(reads).toBe(0);
    });

    it("names the assets in the run's seeded order", async () => {
      const s = withOpening({ order: { assetFirst: "fsiu", tools: ["pay_split", "pay_with_usdc", "pay_with_held_claim"] } });
      expect(await s.infoTextFor("ORCHESTRATOR")).toContain("YOU HOLD: 4,400 mSIU of fSIU (= 6,323 USDC minor units at this print) and 8,364 USDC minor units");
    });

    it("writes a quote the buyer has received in SIU, leading with the work, then what settling costs in each asset", () => {
      const n = need1();
      books.requestPosted("qr-1", n.buyer, n.seller);
      books.quoteIssued("qr-1");
      const line = svc.describeQuote({ requestId: "qr-1", quote: { expiry: "2026-10-07T14:00:00Z" } as never })!;
      expect(line).toBe(
        `${n.type} job from ${n.seller}, 1 SIU of work, price 1.2 SIU — settle 0.001725 USD or 1,200 mSIU of fSIU (print 0.001437 USD/SIU), expires 2026-10-07T14:00:00Z`,
      );
    });

    it("writes the seller's line for a request the same way, naming who asked, and a unit of raw work likewise", () => {
      const n = need1();
      books.requestPosted("qr-1", n.buyer, n.seller);
      expect(svc.describeRequest({ requestId: "qr-1" } as never)).toBe(
        `${n.type} job asked for by ${n.buyer}, 1 SIU of work, price 1.2 SIU — settle 0.001725 USD or 1,200 mSIU of fSIU (print 0.001437 USD/SIU)`,
      );
      books.requestPosted("qr-2", n.buyer, "ISSUER");
      books.quoteIssued("qr-2");
      expect(svc.describeQuote({ requestId: "qr-2", quote: { expiry: "x" } as never })).toBe(
        "a unit of raw work from ISSUER-B, 1 SIU of work, price 1 SIU — settle 0.001437 USD or 1,000 mSIU of fSIU (print 0.001437 USD/SIU), expires x",
      );
    });

    it("leaves a request it does not know to the board's own line", () => {
      expect(svc.describeRequest({ requestId: "qr-404" } as never)).toBeUndefined();
      expect(svc.describeQuote({ requestId: "qr-404", quote: { expiry: "x" } as never })).toBeUndefined();
    });

    it("sizes the claim that pays a quote at its price in mSIU, whatever the print: 1,200 for a job and 1,000 for a unit of raw work", () => {
      const n = need1();
      books.requestPosted("qr-1", n.buyer, n.seller);
      books.requestPosted("qr-2", n.buyer, "ISSUER");
      expect(svc.claimForQuote("qr-1")).toBe(1_200n);
      expect(svc.claimForQuote("qr-2")).toBe(1_000n);
      expect(svc.claimForQuote("qr-404")).toBeUndefined();
    });

    it("keeps its own record of a successful call, by agent and turn, for the report's decisions", async () => {
      const n = need1();
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-5", turn: 7, result: { seller_id: ids.traders[n.seller] } }));
      expect(svc.eventAt(seat(n.buyer), 7)).toEqual({ requestId: "qr-5", result: { seller_id: ids.traders[n.seller] } });
      expect(svc.eventAt(seat(n.buyer), 8)).toBeUndefined();
    });
  });

  describe("each payment moves the payer's and the payee's wallet by exactly what it moved (D50)", () => {
    const OPENING = { usdcMinor: 8_364n, fsiuMilliSiu: 4_400n };
    const withOpening = (): LabService =>
      new LabService({ books, guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS }, seed: 4, executorFor: () => executor, tokenId: "777", opening: OPENING });
    const job = () => need1();

    it("starts every trader at the opening, and hands out copies nobody can move from outside", () => {
      const s = withOpening();
      for (const t of LAB_TRADERS) expect(s.walletOf(t)).toEqual(OPENING);
      s.walletOf("TRADER-1")!.usdcMinor = 0n;
      expect(s.walletOf("TRADER-1")).toEqual(OPENING);
    });

    it("moves the quote's dollars from the buyer to the seller when it is paid in USDC", async () => {
      svc = withOpening();
      const n = await payNeed("qr-1", "pay");
      // A job at the illustrative print: 1.2 SIU x 0.001437 = 1,725 USDC minor units.
      expect(svc.walletOf(n.buyer)).toEqual({ usdcMinor: 8_364n - 1_725n, fsiuMilliSiu: 4_400n });
      expect(svc.walletOf(n.seller)).toEqual({ usdcMinor: 8_364n + 1_725n, fsiuMilliSiu: 4_400n });
    });

    it("moves exactly the price in mSIU when it is paid in claims: 1,200 for a job", async () => {
      svc = withOpening();
      const n = await payNeed("qr-1", "transfer_claim");
      expect(svc.walletOf(n.buyer)).toEqual({ usdcMinor: 8_364n, fsiuMilliSiu: 4_400n - 1_200n });
      expect(svc.walletOf(n.seller)).toEqual({ usdcMinor: 8_364n, fsiuMilliSiu: 4_400n + 1_200n });
    });

    it("moves a split's claim part and the rest of the dollars: the quote's less the claim part's value at the print, rounded down", async () => {
      svc = withOpening();
      const n = job();
      await svc.afterToolCall(ev(seat(n.buyer), "request_quote", { requestId: "qr-1", result: { seller_id: ids.traders[n.seller] } }));
      await svc.afterToolCall(ev(seat(n.seller), "issue_quote", { intentArgs: { requestId: "qr-1" } }));
      await svc.afterToolCall(ev(seat(n.buyer), "settle_split_held", { intentArgs: { requestId: "qr-1", claimQuantityMilliSiu: "600" } }));
      // 600 mSIU at 1.437 USD per SIU is 862.2, so 862 minor units; the quote is 1,725, so 863 in dollars.
      expect(svc.walletOf(n.buyer)).toEqual({ usdcMinor: 8_364n - 863n, fsiuMilliSiu: 4_400n - 600n });
      expect(svc.walletOf(n.seller)).toEqual({ usdcMinor: 8_364n + 863n, fsiuMilliSiu: 4_400n + 600n });
    });

    it("moves the buyer's wallet and no trader's when the payee is the issuer, whose wallet is not kept", async () => {
      svc = withOpening();
      await buyUnit("TRADER-1", "qr-7");
      expect(svc.walletOf("TRADER-1")).toEqual({ usdcMinor: 8_364n - 1_437n, fsiuMilliSiu: 4_400n });
      for (const t of LAB_TRADERS.filter((x) => x !== "TRADER-1")) expect(svc.walletOf(t)).toEqual(OPENING);
    });

    it("moves nothing a second time for a quote already paid, a payment that names no quote, or a request it does not know", async () => {
      svc = withOpening();
      const n = await payNeed("qr-1", "pay");
      const after = svc.walletOf(n.buyer);
      await svc.afterToolCall(ev(seat(n.buyer), "pay", { intentArgs: { requestId: "qr-1" } }));
      await svc.afterToolCall(ev(seat(n.buyer), "transfer_claim", { intentArgs: { agentId: "WORKER-CODE", tokenId: "1", quantity: "1" } }));
      await svc.afterToolCall(ev(seat(n.buyer), "pay", { intentArgs: { requestId: "qr-404" } }));
      expect(svc.walletOf(n.buyer)).toEqual(after);
    });

    it("shows the moved wallet on the next turn", async () => {
      svc = withOpening();
      const n = await payNeed("qr-1", "pay");
      expect(await svc.infoTextFor(seat(n.buyer))).toContain("YOU HOLD: 6,639 USDC minor units");
    });
  });

  describe("the lab's names for its payment tools (D26)", () => {
    const need = () => economy.needs.find((n) => n.round === 1)!;
    const quoted = () => {
      const n = need();
      books.requestPosted("qr-1", n.buyer, n.seller);
      books.quoteIssued("qr-1");
      return n;
    };

    it("describes the three routes in one shape, each settling at once and ending in what it costs", () => {
      const d = (["pay", "transfer_claim", "settle_split_held"] as const).map((t) => svc.toolDescription(t)!);
      expect(d.map((x) => x.split("(")[0])).toEqual(["pay_with_usdc", "pay_with_held_claim", "pay_split"]);
      for (const line of d) expect(line).toMatch(/-> settles a quote you were sent .* at\s+once.* Costs: /s);
      for (const line of d) expect(line).not.toMatch(/escrow|mint/i);
      // The routes that retired with minting have no description: a trader is never shown them.
      expect(svc.toolDescription("pay_with_claim")).toBeUndefined();
      expect(svc.toolDescription("settle_split")).toBeUndefined();
      expect(svc.toolDescription("get_print")).toBeUndefined(); // everything else keeps its own
    });

    it("turns a call by the name the trader knows into the call the loop runs", () => {
      const n = quoted();
      const ZERO = "0x0000000000000000000000000000000000000000";
      expect(svc.resolveCall("ORCHESTRATOR", "pay_with_usdc", { requestId: "qr-1" })).toEqual({ tool: "pay", args: { requestId: "qr-1", settler: ZERO } });
      // A split names the quote and the claim part; the token it is paid from is the lab's to supply.
      expect(svc.resolveCall("ORCHESTRATOR", "pay_split", { requestId: "qr-1", claimQuantityMilliSiu: "592" })).toEqual({
        tool: "settle_split_held",
        args: { requestId: "qr-1", claimQuantityMilliSiu: "592", tokenId: "777" },
      });
      expect(svc.resolveCall("ORCHESTRATOR", "pay_split", { requestId: "qr-9", claimQuantityMilliSiu: "592" })).toEqual({ refuse: "there is no quote qr-9." });
      // Paying with a held claim names only the quote: the seller and the token are the lab's to supply.
      expect(svc.resolveCall("ORCHESTRATOR", "pay_with_held_claim", { requestId: "qr-1" })).toEqual({
        tool: "transfer_claim",
        args: { agentId: n.seller, tokenId: "777", requestId: "qr-1" },
      });
      expect(svc.resolveCall("ORCHESTRATOR", "pay_with_held_claim", { requestId: "qr-9" })).toEqual({ refuse: "there is no quote qr-9." });
    });

    it("refuses the loop's own names for the renamed tools, and for the ones that retired, and leaves every other tool alone", () => {
      for (const internal of ["pay", "transfer_claim", "settle_split_held", "pay_with_claim", "settle_split", "settle_escrow"]) {
        expect(svc.resolveCall("ORCHESTRATOR", internal, { requestId: "qr-1" })).toEqual({ refuse: `${internal} is not one of your tools.` });
      }
      // The old v3 names are not tools of this lab either; the loop refuses them as unknown.
      for (const other of ["request_quote", "issue_quote", "deliver_job", "wait", "pay_with_new_claim"]) {
        expect(svc.resolveCall("ORCHESTRATOR", other, {})).toBeUndefined();
      }
      // get_balances runs as called; it resolves to itself only so the history shows the call as the trader made it.
      expect(svc.resolveCall("ORCHESTRATOR", "get_balances", { account: "0xabc", tokenIds: ["777"] })).toEqual({
        tool: "get_balances",
        args: { account: "0xabc", tokenIds: ["777"] },
      });
    });

    it("writes an internal tool name inside a sentence as the trader knows it", () => {
      expect(svc.rewriteText("transfer_claim: no. settle_split_held: no. pay: no quote.")).toBe(
        "pay_with_held_claim: no. pay_split: no. pay_with_usdc: no quote.",
      );
      expect(svc.rewriteText("you will pay the seller")).toBe("you will pay the seller"); // the word alone is left
    });
  });

  describe("a payment the trader cannot afford is refused in one sentence that states the whole wallet (D33)", () => {
    const withHoldings = (usdcMinor: bigint, fsiuMilliSiu: bigint): LabService =>
      new LabService({
        books,
        guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS },
        seed: 4,
        executorFor: () => executor,
        tokenId: "777",
        holdings: async () => ({ usdcMinor, fsiuMilliSiu }),
      });
    const quotedTrade = () => {
      const n = economy.needs.find((x) => x.round === 1)!;
      books.requestPosted("qr-1", n.buyer, n.seller);
      books.quoteIssued("qr-1");
      return SEAT_OF[n.buyer];
    };
    // At the illustrative print a job's quote is 1,725 minor units or 1,200 mSIU; a unit of raw work's is 1,437 or 1,000 (D50).

    it("states the cost, then both assets the wallet holds, in the same form for dollars, a held claim and a split", async () => {
      const buyer = quotedTrade();
      const poor = withHoldings(100n, 100n);
      const wallet = "the wallet holds 100 USDC minor units and 100 mSIU of fSIU.";
      expect(await poor.guard(buyer, "pay", { requestId: "qr-1" })).toBe(`This payment costs 1,725 USDC minor units; ${wallet}`);
      expect(await poor.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toBe(`This payment costs 1,200 mSIU of fSIU; ${wallet}`);
      // 592 mSIU is worth 850 minor units at the print (floored), so the dollar part is the other 875.
      expect(await poor.guard(buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "592" })).toBe(
        `This payment costs 875 USDC minor units and 592 mSIU of fSIU; ${wallet}`,
      );
    });

    it("says it in exactly the words the user gave, for a wallet that holds 1,174 USDC and 2,000 mSIU (the pilot's TRADER-4)", async () => {
      const n = economy.needs.find((x) => x.round === 1)!;
      books.requestPosted("qr-raw", n.buyer, "ISSUER");
      books.quoteIssued("qr-raw");
      // The raw-work quote costs 1,437 USDC minor units: more than the 1,174 held, though 2,000 mSIU would pay it.
      expect(await withHoldings(1_174n, 2_000n).guard(SEAT_OF[n.buyer], "pay", { requestId: "qr-raw" })).toBe(
        "This payment costs 1,437 USDC minor units; the wallet holds 1,174 USDC minor units and 2,000 mSIU of fSIU.",
      );
    });

    it("lets a payment through when the wallet holds enough of the asset it spends, and judges each route by what it spends", async () => {
      const buyer = quotedTrade();
      const dollarsOnly = withHoldings(5_000n, 0n);
      expect(await dollarsOnly.guard(buyer, "pay", { requestId: "qr-1" })).toBeNull();
      expect(await dollarsOnly.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toContain("costs 1,200 mSIU of fSIU; the wallet holds 5,000 USDC minor units and 0 mSIU of fSIU");
      const claimsOnly = withHoldings(0n, 5_000n);
      expect(await claimsOnly.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toBeNull();
      expect(await claimsOnly.guard(buyer, "pay", { requestId: "qr-1" })).toContain("USDC minor units");
    });

    it("lets a split through for a wallet that holds some of each, where neither asset alone would pay", async () => {
      const buyer = quotedTrade();
      const straddling = withHoldings(1_174n, 816n); // the pilot's TRADER-3: neither 1,725 USDC nor 1,200 mSIU
      expect(await straddling.guard(buyer, "pay", { requestId: "qr-1" })).toContain("This payment costs 1,725 USDC minor units");
      expect(await straddling.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toContain("This payment costs 1,200 mSIU of fSIU");
      // 500 mSIU is worth 718 minor units; the dollar part is 1,007: 1,174 and 816 cover it.
      expect(await straddling.guard(buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "500" })).toBeNull();
    });

    it("refuses a split when either of its parts is short, and says what both parts cost", async () => {
      const buyer = quotedTrade();
      expect(await withHoldings(5_000n, 100n).guard(buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "500" })).toBe(
        "This payment costs 1,007 USDC minor units and 500 mSIU of fSIU; the wallet holds 5,000 USDC minor units and 100 mSIU of fSIU.",
      );
      expect(await withHoldings(100n, 5_000n).guard(buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "500" })).toContain(
        "This payment costs 1,007 USDC minor units and 500 mSIU of fSIU; the wallet holds 100 USDC minor units and 5,000 mSIU of fSIU.",
      );
    });

    it("is the same sentence whichever asset is short, differing only in the cost and the figures", async () => {
      const buyer = quotedTrade();
      const poor = withHoldings(0n, 0n);
      const shape = (s: string) => s.replace(/\d[\d,]*/g, "N");
      expect(shape((await poor.guard(buyer, "pay", { requestId: "qr-1" }))!)).toBe(
        "This payment costs N USDC minor units; the wallet holds N USDC minor units and N mSIU of fSIU.",
      );
      expect(shape((await poor.guard(buyer, "transfer_claim", { requestId: "qr-1" }))!)).toBe(
        "This payment costs N mSIU of fSIU; the wallet holds N USDC minor units and N mSIU of fSIU.",
      );
    });

    it("never advises, and names no asset beyond the units it counts", async () => {
      const buyer = quotedTrade();
      const poor = withHoldings(0n, 0n);
      for (const tool of ["pay", "transfer_claim", "settle_split_held"] as const) {
        const s = (await poor.guard(buyer, tool, { requestId: "qr-1", claimQuantityMilliSiu: "592" }))!;
        expect(s).not.toMatch(/should|better|cheaper|prefer|instead|try|could|only/i);
      }
    });

    it("does not ask the chain at all for a call the lab's own rules already refuse", async () => {
      quotedTrade();
      let reads = 0;
      const svc2 = new LabService({
        books,
        guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS },
        seed: 4,
        executorFor: () => executor,
        tokenId: "777",
        holdings: async () => {
          reads++;
          return { usdcMinor: 0n, fsiuMilliSiu: 0n };
        },
      });
      const stranger = (["ORCHESTRATOR", "WORKER-CODE", "WORKER-EXTRACT", "ISSUER-A"] as const).find((s) => s !== quotedTrade() && SEAT_OF[economy.needs[0].seller] !== s)!;
      expect(await svc2.guard(stranger, "pay", { requestId: "qr-1" })).toContain("not yours to pay");
      // A claim part the lab's own rules refuse is refused before the chain is asked, too.
      expect(await svc2.guard(SEAT_OF[economy.needs.find((x) => x.round === 1)!.buyer], "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "99999" })).toContain("the claim part of a split must be less than the quote's price");
      expect(reads).toBe(0);
    });
  });

  describe("a print that moves between rounds (D41)", () => {
    const path = buildPrintPath(9, 1_437_000n, DEFAULT_PARAMS, "real-print");
    const movingBooks = () => new LabBooks(economy, ids, path);
    const movingService = (b: LabBooks, holdings?: LabServiceDeps["holdings"]): LabService =>
      new LabService({
        books: b,
        // A getter, as the runner builds it: the guards and the board follow the round.
        guard: {
          get printNano(): bigint {
            return b.currentPrint()!;
          },
          params: DEFAULT_PARAMS,
        },
        seed: 4,
        executorFor: () => executor,
        tokenId: "777",
        ...(holdings !== undefined ? { holdings } : {}),
      });
    const quotedInRound1 = (b: LabBooks) => {
      const n = economy.needs.find((x) => x.round === 1)!;
      b.requestPosted("qr-1", n.buyer, n.seller);
      b.quoteIssued("qr-1");
      return n;
    };

    it("writes the current round's print id into a quote request, over the one the agent copied from its brief", () => {
      const b = movingBooks();
      const svc2 = movingService(b);
      const asked = { siu: "1", model: "m", rateUsdPerSiu: "0.0017244", indexVersion: "SIU-2026a", printId: "real-print", printHash: "0x00", sellerId: "s", chain: "c", expiresInSeconds: 1, pattern: "fixed" };
      expect(svc2.resolveCall("ORCHESTRATOR", "request_quote", asked)).toEqual({ tool: "request_quote", args: { ...asked, printId: "real-print" } });
      b.advanceRound();
      // Round 2: the agent still copies round 1's id from the brief; the lab writes round 2's scenario print, which is not the published one.
      expect(svc2.resolveCall("ORCHESTRATOR", "request_quote", asked)).toEqual({ tool: "request_quote", args: { ...asked, printId: "lab-scenario-round-2" } });
    });

    it("leaves a quote request alone in a lab with no print path, and never touches another tool's arguments", () => {
      expect(svc.resolveCall("ORCHESTRATOR", "request_quote", { siu: "1" })).toBeUndefined();
      const svc2 = movingService(movingBooks());
      expect(svc2.resolveCall("ORCHESTRATOR", "issue_quote", { requestId: "qr-1" })).toBeUndefined();
    });

    it("says what print a quote was asked for at, so a claim paid against it is sized there, even rounds later", () => {
      const b = movingBooks();
      const svc2 = movingService(b);
      quotedInRound1(b);
      b.advanceRound();
      b.advanceRound();
      expect(svc2.printForQuote("qr-1")).toBe(path.byRound[0]);
      expect(b.currentPrint()).toBe(path.byRound[2]);
      expect(svc2.printForQuote("qr-nope")).toBeUndefined();
    });

    it("judges whether a payment is affordable at the quote's print, not the current one", async () => {
      const b = movingBooks();
      const n = quotedInRound1(b);
      const buyer = SEAT_OF[n.buyer];
      // The quote's claim at round 1's print is 1,184 mSIU; a wallet holding exactly that can pay it in round 3, when the print has moved.
      const exact = movingService(b, async () => ({ usdcMinor: 0n, fsiuMilliSiu: 1_200n }));
      b.advanceRound();
      b.advanceRound();
      expect(b.currentPrint()).not.toBe(path.byRound[0]);
      expect(await exact.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toBeNull();
      const short = movingService(b, async () => ({ usdcMinor: 0n, fsiuMilliSiu: 1_199n }));
      expect(await short.guard(buyer, "transfer_claim", { requestId: "qr-1" })).toBe(
        "This payment costs 1,200 mSIU of fSIU; the wallet holds 0 USDC minor units and 1,199 mSIU of fSIU.",
      );
    });

    it("prices a quote asked for in a later round at that round's print: the same job costs a different amount of USDC and exactly the same fSIU (D50)", async () => {
      const b = movingBooks();
      b.advanceRound();
      const n = economy.needs.find((x) => x.round <= 2)!;
      b.requestPosted("qr-2", n.buyer, n.seller);
      b.quoteIssued("qr-2");
      const p2 = path.byRound[1];
      const svc2 = movingService(b, async () => ({ usdcMinor: 0n, fsiuMilliSiu: 0n }));
      const cost = (await svc2.guard(SEAT_OF[n.buyer], "pay", { requestId: "qr-2" }))!;
      const usd = quoteTerms("trade", p2, DEFAULT_PARAMS).minorUnits;
      expect(usd).not.toBe(1_725n);
      expect(cost).toContain(`costs ${fmt(usd)} USDC minor units`);
      const claim = (await svc2.guard(SEAT_OF[n.buyer], "transfer_claim", { requestId: "qr-2" }))!;
      expect(claim).toContain("costs 1,200 mSIU of fSIU");
      expect(svc2.claimForQuote("qr-2")).toBe(1_200n);
    });
  });
});
