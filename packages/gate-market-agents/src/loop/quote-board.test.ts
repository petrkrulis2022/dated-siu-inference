import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import { QuoteBoard } from "./quote-board.js";

function fakeQuoteBody(sellerId: string, overrides: Partial<QuoteBody> = {}): QuoteBody {
  return {
    schema_version: "2.0",
    siu: "10",
    pattern: "fixed",
    model: "test-model",
    rate_usd_per_siu: "0.05",
    amount_usd_max: "0.5",
    index_version: "SIU-2026a",
    print_id: "2026-09-25",
    print_hash: "0xabc",
    seller_id: sellerId,
    expiry: "2026-09-26T00:00:00Z",
    settlement: [{ asset: "usdc", address: "0x0", amount_max: "500000" }],
    ...overrides,
  } as QuoteBody;
}

function fakeQuote(sellerId: string): TouchstoneQuote {
  return { ...fakeQuoteBody(sellerId), sig: "0xdeadbeef" } as TouchstoneQuote;
}

describe("QuoteBoard", () => {
  it("makes a posted request visible only to the seller it names", () => {
    const board = new QuoteBoard();
    board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));

    expect(board.openRequestsFor("erc8004:0xWORKERCODE")).toHaveLength(1);
    expect(board.openRequestsFor("erc8004:0xWORKEREXTRACT")).toHaveLength(0);
  });

  it("makes an issued quote visible only to the original buyer, never the wrong agent", () => {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));

    expect(board.issuedQuotesFor("ORCHESTRATOR")).toHaveLength(1);
    expect(board.issuedQuotesFor("HEDGER")).toHaveLength(0);
  });

  it("stops showing a request as open once it's been answered", () => {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    expect(board.openRequestsFor("erc8004:0xWORKERCODE")).toHaveLength(1);

    board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));
    expect(board.openRequestsFor("erc8004:0xWORKERCODE")).toHaveLength(0);
  });

  it("renderFor returns an empty string when there is nothing for that agent to see", () => {
    const board = new QuoteBoard();
    board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    // A different agent, not the named seller and not the buyer.
    expect(board.renderFor("WORKER-EXTRACT", "erc8004:0xWORKEREXTRACT")).toBe("");
  });

  it("renderFor shows the open request to the named seller, structured, not free text", () => {
    const board = new QuoteBoard();
    board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    const rendered = board.renderFor("WORKER-CODE", "erc8004:0xWORKERCODE");
    expect(rendered).toContain("qr-1");
    expect(rendered).toContain("ORCHESTRATOR");
    expect(rendered).toContain("10 SIU");
  });

  it("renderFor shows an issued quote back to the buyer", () => {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));
    const rendered = board.renderFor("ORCHESTRATOR", "erc8004:0xORCHESTRATOR");
    expect(rendered).toContain("qr-1");
    expect(rendered).toContain("erc8004:0xWORKERCODE");
  });

  it("requestById finds a real posted request by id, undefined for an unknown one", () => {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    expect(board.requestById(request.requestId)?.buyer).toBe("ORCHESTRATOR");
    expect(board.requestById("qr-999")).toBeUndefined();
  });

  it("issuedQuoteById returns the exact, real signed quote for a request — never a reconstruction", () => {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    const quote = fakeQuote("erc8004:0xWORKERCODE");
    board.postIssuedQuote(request.requestId, quote);
    expect(board.issuedQuoteById(request.requestId)).toBe(quote);
    expect(board.issuedQuoteById("qr-999")).toBeUndefined();
  });

  it(
    "tells a PAID SELLER it owes the work — the fact the dollar route turns on, and the one the " +
      "board could not carry before 2026-09-29, when WORKER-CODE slept through a job it had been " +
      "paid for while real USDC sat in escrow",
    () => {
      const board = new QuoteBoard();
      const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
      board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));

      // Before payment the seller is owed nothing and must not be told otherwise.
      expect(board.renderFor("WORKER-CODE", "erc8004:0xWORKERCODE")).not.toContain(
        "YOU HAVE BEEN PAID",
      );

      board.recordPaid(request.requestId);
      const paidView = board.renderFor("WORKER-CODE", "erc8004:0xWORKERCODE");
      expect(paidView).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
      expect(paidView).toContain(request.requestId);

      // Settling discharges it — the board stops asking for work already delivered.
      board.recordSettled(request.requestId);
      expect(board.renderFor("WORKER-CODE", "erc8004:0xWORKERCODE")).not.toContain(
        "YOU HAVE BEEN PAID",
      );
    },
  );

  it(
    "stops showing a buyer a quote it has already paid — showing resolved state is what woke " +
      "ORCHESTRATOR on a turn with nothing left to do",
    () => {
      const board = new QuoteBoard();
      const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
      board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));

      expect(board.unpaidQuotesFor("ORCHESTRATOR")).toHaveLength(1);
      expect(board.renderFor("ORCHESTRATOR", "erc8004:0xORCHESTRATOR")).toContain(
        "Quotes you have received",
      );

      board.recordPaid(request.requestId);
      expect(board.unpaidQuotesFor("ORCHESTRATOR")).toHaveLength(0);
      // Nothing actionable left for the buyer at all, so the board is empty for it — which is what
      // lets a wake gate keyed on "the board has something" actually let it idle.
      expect(board.renderFor("ORCHESTRATOR", "erc8004:0xORCHESTRATOR")).toBe("");
    },
  );

  it(
    "a paid quote is owed by its seller and resolved for its buyer at the same time — the two " +
      "views never disagree",
    () => {
      const board = new QuoteBoard();
      const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
      board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));
      board.recordPaid(request.requestId);

      expect(board.isPaid(request.requestId)).toBe(true);
      expect(board.paidUnsettledFor("erc8004:0xWORKERCODE")).toHaveLength(1);
      expect(board.unpaidQuotesFor("ORCHESTRATOR")).toHaveLength(0);
    },
  );
});



describe("QuoteBoard — what each asset tells the seller it was paid in", () => {
  const seller = "erc8004:0xWORKERCODE";
  function paidBoard(asset?: "usdc" | "fsiu" | "split") {
    const board = new QuoteBoard();
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody(seller));
    board.postIssuedQuote(request.requestId, fakeQuote(seller));
    // The second argument is the asset. Against a board that predates it the argument is
    // ignored and the quote is treated as dollar-paid, which is exactly the defect.
    (board.recordPaid as (id: string, asset?: string) => void)(request.requestId, asset);
    return { board, requestId: request.requestId };
  }

  it("does not tell a seller paid in fSIU that real USDC is in escrow for it", () => {
    // Payment by claim moves no escrow at all: the claim is transferred outright. The notice
    // "real USDC is in escrow in your favour ... settle_escrow" is simply false there, and it
    // names tools the claim holder cannot use (submit_job is refused to a holder, §4.6a). With
    // payment symmetry every claim payment carries a requestId, so every fSIU window would have
    // shown it.
    const { board } = paidBoard("fsiu");
    const view = board.renderFor("WORKER-CODE", seller);
    expect(view).not.toContain("real USDC is in escrow");
    expect(view).not.toContain("settle_escrow");
    expect(view).not.toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
  });

  it("shows an fSIU-paid quote to its seller as NOTHING, because nothing could ever clear it", () => {
    // The dollar notice ends when the seller calls settle_escrow. There is no equivalent for a
    // claim, so a standing notice would never go away — and the stall guard treats any board
    // text as proof somebody can still act, so it would hold the window open indefinitely. The
    // claim's arrival is told through the holder section, which ends when the claim is presented.
    const { board } = paidBoard("fsiu");
    expect(board.paidUnsettledFor(seller)).toHaveLength(0);
    expect(board.renderFor("WORKER-CODE", seller)).toBe("");
  });

  it("still tells a USDC-paid seller, which is where the notice is true", () => {
    const { board, requestId } = paidBoard("usdc");
    const view = board.renderFor("WORKER-CODE", seller);
    expect(view).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
    expect(view).toContain(requestId);
  });

  it("treats an unstated asset as the dollar route, so every existing caller is unchanged", () => {
    const { board } = paidBoard(undefined);
    expect(board.renderFor("WORKER-CODE", seller)).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
  });

  it("tells a seller paid partly in each, because the dollar leg is real escrow", () => {
    const { board } = paidBoard("split");
    expect(board.renderFor("WORKER-CODE", seller)).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
  });

  it("resolves the quote for its buyer whichever asset paid it", () => {
    for (const asset of ["usdc", "fsiu", "split"] as const) {
      const { board } = paidBoard(asset);
      expect(board.unpaidQuotesFor("ORCHESTRATOR"), asset).toHaveLength(0);
      expect(board.isPaid(board.issuedQuotesFor("ORCHESTRATOR")[0]!.requestId), asset).toBe(true);
    }
  });
});

describe("QuoteBoard — the 'you have been paid' line names only tools the roster holds", () => {
  const paidBoard = (options?: { reservationStep?: boolean }) => {
    const board = new QuoteBoard(options);
    const request = board.postRequest("ORCHESTRATOR", fakeQuoteBody("erc8004:0xWORKERCODE"));
    board.postIssuedQuote(request.requestId, fakeQuote("erc8004:0xWORKERCODE"));
    board.recordPaid(request.requestId, "usdc");
    return board.renderFor("WORKER-CODE", "erc8004:0xWORKERCODE");
  };

  it("tells a seller to reserve capacity first, by default — the gate configuration's dollar route", () => {
    expect(paidBoard()).toContain("reserve_for_work");
  });

  it("does not name that tool where the roster has none, and still says the seller is owed the work", () => {
    const text = paidBoard({ reservationStep: false });
    expect(text).not.toContain("reserve_for_work");
    expect(text).toContain("YOU HAVE BEEN PAID AND OWE THE WORK");
    expect(text).toContain("answers qr-1: amount_usd_max");
  });
});
