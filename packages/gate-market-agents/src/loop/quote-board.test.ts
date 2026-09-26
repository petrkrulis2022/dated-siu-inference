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
});
