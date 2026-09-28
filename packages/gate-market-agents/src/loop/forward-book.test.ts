import { describe, expect, it } from "vitest";
import { ForwardQuoteBook } from "./forward-book.js";

const base = {
  issuer: "ISSUER-A" as const,
  forWindow: 2,
  statedInWindow: 1,
  rateUsdPerSiu: "0.0020",
  maxQuantityMilliSiu: "5000",
  issuerHeadroomAtQuote: "24000",
};

describe("ForwardQuoteBook", () => {
  it("records a quote nobody takes, which is the whole reason it exists", () => {
    const book = new ForwardQuoteBook();
    const quote = book.record(base);
    expect(quote.takenInWindow).toBeNull();
    expect(quote.takenBy).toBeNull();
    // A book that only kept accepted terms would show a market that always clears.
    expect(book.all()).toHaveLength(1);
    expect(book.openFor(2)).toHaveLength(1);
  });

  it("marks a take once and refuses a second, so who took it first cannot be overwritten", () => {
    const book = new ForwardQuoteBook();
    const quote = book.record(base);
    expect(book.markTaken(quote.quoteId, "ORCHESTRATOR", 2)).toBe(true);
    expect(book.markTaken(quote.quoteId, "WORKER-CODE", 2)).toBe(false);
    expect(book.byId(quote.quoteId)?.takenBy).toBe("ORCHESTRATOR");
    expect(book.byId(quote.quoteId)?.takenInWindow).toBe(2);
    // A taken offer leaves the open list, so a later window's buyer is not shown it.
    expect(book.openFor(2)).toHaveLength(0);
  });

  it("refuses to mark an offer that does not exist rather than inventing one", () => {
    expect(new ForwardQuoteBook().markTaken("fwd-404", "ORCHESTRATOR", 1)).toBe(false);
  });

  it("orders open offers by the issuers' own numbers, cheapest first", () => {
    const book = new ForwardQuoteBook();
    book.record({ ...base, issuer: "ISSUER-A", rateUsdPerSiu: "0.0030" });
    book.record({ ...base, issuer: "ISSUER-B", rateUsdPerSiu: "0.0010" });
    expect(book.openFor(2).map((q) => q.issuer)).toEqual(["ISSUER-B", "ISSUER-A"]);
  });

  it("shows an issuer its own offers and a buyer the ones open to it, never the reverse", () => {
    const book = new ForwardQuoteBook();
    book.record(base);
    const issuerView = book.renderFor("ISSUER-A", 1, true);
    expect(issuerView).toContain("FORWARD TERMS YOU HAVE STATED");
    expect(issuerView).toContain("not taken");
    // ISSUER-B stated nothing, so it sees nothing — not an empty header.
    expect(book.renderFor("ISSUER-B", 1, true)).toBe("");

    const buyerView = book.renderFor("ORCHESTRATOR", 1, false);
    expect(buyerView).toContain("ISSUER-A offers up to 5000 mSIU for window 2");
    expect(buyerView).toContain("their headroom when they quoted: 24000 mSIU");
  });

  it("tells a buyer plainly that a forward term is not a contract", () => {
    const book = new ForwardQuoteBook();
    book.record(base);
    const buyerView = book.renderFor("ORCHESTRATOR", 1, false);
    // The gap this testbed does not close must be visible wherever the offer is, not only in the
    // spec — an agent reading a price with no such note would reasonably read it as binding.
    expect(buyerView).toContain("stated prices, not binding contracts");
    expect(buyerView).toContain("still mints at the published print rate");
  });

  it("renders nothing at all when there is nothing to show", () => {
    const book = new ForwardQuoteBook();
    expect(book.renderFor("ORCHESTRATOR", 1, false)).toBe("");
    expect(book.renderFor("ISSUER-A", 1, true)).toBe("");
  });
});
