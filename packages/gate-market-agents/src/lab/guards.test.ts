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

  describe("settle_escrow", () => {
    it("is refused for a trader until it has delivered the job whose escrow it would release", () => {
      const need = economy.needs.find((n) => n.round === 1)!;
      books.requestPosted("qr-1", need.buyer, need.seller);
      books.quoteIssued("qr-1");
      books.paid("qr-1", "usdc");
      expect(guardLabCall(books, cfg, need.seller, "settle_escrow", {})).toBe("you have not delivered qr-1, so its escrow is not yet yours to release.");
      expect(guardLabCall(books, cfg, need.seller, "settle_escrow", { requestId: "qr-1" })).toContain("not yet yours");
      books.attempted("qr-1", true);
      expect(guardLabCall(books, cfg, need.seller, "settle_escrow", {})).toBeNull();
    });

    it("never stands between the issuer and the escrow it is paid through", () => {
      books.requestPosted("qr-raw", "TRADER-1", "ISSUER");
      books.paid("qr-raw", "usdc");
      expect(guardLabCall(books, cfg, "ISSUER", "settle_escrow", {})).toBeNull();
    });

    it("does not guard an escrow that is not one of the caller's jobs", () => {
      expect(guardLabCall(books, cfg, "TRADER-1", "settle_escrow", { requestId: "qr-nope" })).toBeNull();
    });
  });

  it("leaves every other tool alone", () => {
    for (const tool of ["pay", "pay_with_claim", "transfer_claim", "settle_split", "get_balances", "issue_quote"] as const) {
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
    ].filter((s): s is string => s !== null);
    for (const s of sentences) expect(s).not.toMatch(/usdc|fsiu|dollar|claim|should|better|cheaper|prefer/i);
  });
});
