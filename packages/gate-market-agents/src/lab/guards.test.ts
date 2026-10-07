import { beforeEach, describe, expect, it } from "vitest";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, LAB_TRADERS, buildEconomy, type Economy, type TraderLabel } from "./economy.js";
import { guardLabCall, type GuardConfig } from "./guards.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};
// An ILLUSTRATIVE print of 0.001437 USD/SIU: trade price "0.0017244", raw work "0.001437".
const cfg: GuardConfig = { printNano: 1_437_000n, params: DEFAULT_PARAMS };

describe("guardLabCall", () => {
  let economy: Economy;
  let books: LabBooks;
  beforeEach(() => {
    economy = buildEconomy(5);
    books = new LabBooks(economy, ids);
  });
  const req = (sellerId: string, siu = "1", rate = "0.0017244") => ({ sellerId, siu, rateUsdPerSiu: rate });
  const buyerWithOpenNeed = () => LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;

  describe("request_quote to a trader", () => {
    it("accepts exactly an open need at exactly the trade price and size", () => {
      const buyer = buyerWithOpenNeed();
      const need = books.openNeeds(buyer)[0];
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(ids.traders[need.seller]))).toBeNull();
      // The same figure written with trailing zeros is the same price.
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(ids.traders[need.seller], "1.000", "0.00172440"))).toBeNull();
    });

    it("refuses a wrong price and a wrong size, and names the right ones", () => {
      const buyer = buyerWithOpenNeed();
      const sellerId = ids.traders[books.openNeeds(buyer)[0].seller];
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "1", "0.001")))
        .toBe("a job is priced at 0.0017244 USD per SIU.");
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "2"))).toBe("a job is 1 SIU.");
    });

    it("refuses a seller the trader has no open need of, and says what it does have", () => {
      const buyer = buyerWithOpenNeed();
      const wrong = LAB_TRADERS.find((t) => t !== buyer && !books.openNeeds(buyer).some((n) => n.seller === t))!;
      const why = guardLabCall(books, cfg, buyer, "request_quote", req(ids.traders[wrong]))!;
      expect(why).toContain(`you have no open need that ${wrong} can deliver`);
      expect(why).toContain("Your open needs:");
    });

    it("says when a need opens, if that is why it is refused", () => {
      const locked = economy.needs.find((n) => n.round > 1)!;
      const why = guardLabCall(books, cfg, locked.buyer, "request_quote", req(ids.traders[locked.seller]));
      if (books.openNeeds(locked.buyer).some((n) => n.seller === locked.seller)) return; // another open need of that seller
      expect(why).toContain(`opens in round ${locked.round}`);
    });

    it("refuses a second request for a need already in flight", () => {
      const buyer = buyerWithOpenNeed();
      const need = books.openNeeds(buyer)[0];
      const sellerId = ids.traders[need.seller];
      // Every open need of that seller is taken before the second ask.
      for (const n of books.openNeeds(buyer).filter((x) => x.seller === need.seller)) books.requestPosted(`qr-${n.id}`, buyer, n.seller);
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId))).toContain("no open need");
    });

    it("refuses buying from yourself, from a stranger, and a request with no seller", () => {
      expect(guardLabCall(books, cfg, "TRADER-1", "request_quote", req(ids.traders["TRADER-1"]))).toBe("a job cannot be bought from yourself.");
      expect(guardLabCall(books, cfg, "TRADER-1", "request_quote", req("erc8004:0xnope"))).toContain("is not a trader or the issuer");
      expect(guardLabCall(books, cfg, "TRADER-1", "request_quote", { siu: "1" })).toBe("request_quote needs a sellerId.");
    });
  });

  describe("request_quote to the issuer — raw work", () => {
    const owe = (seller: TraderLabel) => {
      const need = economy.needs.find((n) => n.seller === seller && n.round === 1);
      if (!need) return false;
      books.requestPosted(`qr-${need.id}`, need.buyer, seller);
      books.paid(`qr-${need.id}`, "usdc");
      return true;
    };

    it("is refused while the trader owes nothing that lacks a unit", () => {
      expect(guardLabCall(books, cfg, "TRADER-1", "request_quote", req(ids.issuer, "1", "0.001437"))).toContain("nothing to buy from the issuer");
    });

    it("is accepted at exactly the print once a delivery is owed", () => {
      const seller = LAB_TRADERS.find((t) => owe(t))!;
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1", "0.001437"))).toBeNull();
    });

    it("is refused at any other price, naming the print", () => {
      const seller = LAB_TRADERS.find((t) => owe(t))!;
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1", "0.0017244")))
        .toBe("raw work is sold at the published print, 0.001437 USD per SIU.");
    });

    it("is refused once the trader holds, or has ordered, a unit for each delivery it owes", () => {
      const seller = LAB_TRADERS.find((t) => owe(t))!;
      books.requestPosted("qr-raw", seller, "ISSUER");
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1", "0.001437"))).toContain("nothing to buy");
    });
  });

  describe("paying a quote — by the trader who asked for it, once", () => {
    // Found by the first model run (2026-10-06): a seller called pay_with_claim on a quote it had issued, which its
    // buyer had already paid, and it went through: a claim minted to itself, recorded against the wrong trader.
    const PAYING = ["pay", "settle_split_held", "transfer_claim"] as const;
    const quoted = () => {
      const need = economy.needs.find((n) => n.round === 1)!;
      books.requestPosted("qr-1", need.buyer, need.seller);
      books.quoteIssued("qr-1");
      return need;
    };

    it("lets the buyer pay its own quote, by every route", () => {
      const need = quoted();
      for (const tool of PAYING) {
        const args = tool === "settle_split_held" ? { requestId: "qr-1", claimQuantityMilliSiu: "500" } : { requestId: "qr-1" };
        expect(guardLabCall(books, cfg, need.buyer, tool, args), tool).toBeNull();
      }
    });

    it("refuses the seller, and anyone else, paying a quote that is not theirs — by every route", () => {
      const need = quoted();
      const stranger = LAB_TRADERS.find((t) => t !== need.buyer && t !== need.seller)!;
      for (const tool of PAYING) {
        expect(guardLabCall(books, cfg, need.seller, tool, { requestId: "qr-1" }), `${tool} by the seller`).toBe(
          `qr-1 is not yours to pay: it was asked for by ${need.buyer}.`,
        );
        expect(guardLabCall(books, cfg, stranger, tool, { requestId: "qr-1" }), `${tool} by a stranger`).toContain("not yours to pay");
      }
    });

    it("refuses a second payment of a quote that has been paid, by every route — with direct settlement nothing on the chain stops one", () => {
      const need = quoted();
      books.paid("qr-1", "usdc");
      for (const tool of PAYING) expect(guardLabCall(books, cfg, need.buyer, tool, { requestId: "qr-1" }), tool).toBe("qr-1 has already been paid.");
    });

    it("refuses a quote that has not been answered yet", () => {
      const need = economy.needs.find((n) => n.round === 1)!;
      books.requestPosted("qr-1", need.buyer, need.seller);
      expect(guardLabCall(books, cfg, need.buyer, "pay", { requestId: "qr-1" })).toBe("qr-1 has not been quoted yet.");
    });

    it("never lets the issuer pay", () => {
      books.requestPosted("qr-raw", "TRADER-1", "ISSUER");
      books.quoteIssued("qr-raw");
      expect(guardLabCall(books, cfg, "ISSUER", "pay", { requestId: "qr-raw" })).toBe("the issuer does not pay quotes.");
    });

    it("leaves a transfer that names no quote alone — it settles nothing — and a quote this lab does not know to the loop's own refusal", () => {
      expect(guardLabCall(books, cfg, "TRADER-1", "transfer_claim", { agentId: "TRADER-2", tokenId: "7", quantity: "100" })).toBeNull();
      expect(guardLabCall(books, cfg, "TRADER-1", "pay", { requestId: "answers qr-9" })).toBeNull();
    });
  });

  describe("the claim part of a split (pay_split)", () => {
    const quoted = () => {
      const need = economy.needs.find((n) => n.round === 1)!;
      books.requestPosted("qr-1", need.buyer, need.seller);
      books.quoteIssued("qr-1");
      return need;
    };
    // A job's quote is 1,700 minor units at the illustrative print 0.001437 USD per SIU; 1 mSIU is worth 1.437 of them.
    const split = (claim: unknown) => ({ requestId: "qr-1", claimQuantityMilliSiu: claim });

    it("accepts a claim part worth something and less than the price", () => {
      const need = quoted();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("500"))).toBeNull();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("1182"))).toBeNull();
    });

    it("refuses anything that is not a whole number of mSIU, more than none", () => {
      const need = quoted();
      for (const bad of ["0", "-5", "1.5", "five", "", undefined, 500]) {
        expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split(bad)), String(bad)).toBe(
          "the claim part of a split is a whole number of mSIU, more than 0.",
        );
      }
    });

    it("refuses a claim part worth the whole price or more, stating what it is worth and what the price is", () => {
      const need = quoted();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("1184"))).toBe(
        "the claim part of a split must be worth more than nothing and less than the quote's price: 1184 mSIU is worth 1701 USDC minor units at the print, and the price is 1700.",
      );
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("5000"))).toContain("must be worth more than nothing and less than");
    });

    it("says nothing about which payment to use instead", () => {
      const need = quoted();
      const refusal = guardLabCall(books, cfg, need.buyer, "settle_split_held", split("5000"))!;
      expect(refusal).not.toMatch(/pay_with|instead|should|better|prefer/i);
    });
  });

  it("leaves the tools that pay nothing alone", () => {
    for (const tool of ["get_balances", "issue_quote", "get_print", "deliver_job"] as const) {
      expect(guardLabCall(books, cfg, "TRADER-1", tool, { requestId: "qr-1" })).toBeNull();
    }
  });

  it("never names an asset, or advises, in anything it says", () => {
    const buyer = buyerWithOpenNeed();
    const sellerId = ids.traders[books.openNeeds(buyer)[0].seller];
    const sentences = [
      guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "1", "0.001")),
      guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "2")),
      guardLabCall(books, cfg, "TRADER-1", "request_quote", req(ids.issuer, "1", "0.001437")),
      (() => {
        const need = economy.needs.find((n) => n.round === 1)!;
        books.requestPosted("qr-p", need.buyer, need.seller);
        books.quoteIssued("qr-p");
        books.paid("qr-p", "usdc");
        return [
          guardLabCall(books, cfg, need.seller, "pay_with_claim", { requestId: "qr-p" }),
          guardLabCall(books, cfg, need.buyer, "pay", { requestId: "qr-p" }),
        ].join(" ");
      })(),
    ].filter((s): s is string => s !== null);
    for (const s of sentences) expect(s).not.toMatch(/usdc|fsiu|dollar|claim|should|better|cheaper|prefer/i);
  });
});
