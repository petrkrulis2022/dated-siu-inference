import { beforeEach, describe, expect, it } from "vitest";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, LAB_TRADERS, buildEconomy, type Economy, type TraderLabel } from "./economy.js";
import { guardLabCall, type GuardConfig } from "./guards.js";
import { printRate } from "./money.js";
import { buildPrintPath } from "./prints.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};
// An ILLUSTRATIVE print of 0.001437 USD/SIU. A quote is priced in SIU (D50): a job at 1.2, a unit of raw work at 1, each at the print as its rate.
const cfg: GuardConfig = { printNano: 1_437_000n, params: DEFAULT_PARAMS };

describe("guardLabCall", () => {
  let economy: Economy;
  let books: LabBooks;
  beforeEach(() => {
    economy = buildEconomy(5);
    books = new LabBooks(economy, ids);
  });
  const req = (sellerId: string, siu = "1.2", rate = "0.001437") => ({ sellerId, siu, rateUsdPerSiu: rate });
  const buyerWithOpenNeed = () => LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;

  describe("request_quote to a trader", () => {
    it("accepts exactly an open need at exactly the job's price in SIU and the print as the rate", () => {
      const buyer = buyerWithOpenNeed();
      const need = books.openNeeds(buyer)[0];
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(ids.traders[need.seller]))).toBeNull();
      // The same figure written with trailing zeros is the same price.
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(ids.traders[need.seller], "1.200", "0.00143700"))).toBeNull();
    });

    it("refuses a wrong price in SIU and a wrong rate, and names the right ones", () => {
      const buyer = buyerWithOpenNeed();
      const sellerId = ids.traders[books.openNeeds(buyer)[0].seller];
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "1.2", "0.001")))
        .toBe("a quote's rate is the print, 0.001437 USD per SIU.");
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "2"))).toBe("a job is priced at 1.2 SIU.");
      // The size of the work, 1 SIU, is not the job's price: asking at it is refused.
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "1"))).toBe("a job is priced at 1.2 SIU.");
      expect(guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "one point two"))).toBe("a job is priced at 1.2 SIU.");
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

    it("is accepted at exactly 1 SIU, at the print, once a delivery is owed", () => {
      const seller = LAB_TRADERS.find((t) => owe(t))!;
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1", "0.001437"))).toBeNull();
    });

    it("is refused at any other rate, naming the print, and at any other price in SIU, naming it", () => {
      const seller = LAB_TRADERS.find((t) => owe(t))!;
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1", "0.0017244")))
        .toBe("a quote's rate is the print, 0.001437 USD per SIU.");
      expect(guardLabCall(books, cfg, seller, "request_quote", req(ids.issuer, "1.2", "0.001437")))
        .toBe("a unit of raw work is priced at 1 SIU.");
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
    // A job's quote is 1,200 mSIU, or 1,725 USDC minor units at the illustrative print 0.001437 USD per SIU; 1 mSIU is worth 1.437 of them.
    const split = (claim: unknown) => ({ requestId: "qr-1", claimQuantityMilliSiu: claim });

    it("accepts a claim part of at least 1 mSIU and less than the quote's price in mSIU", () => {
      const need = quoted();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("500"))).toBeNull();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("1"))).toBeNull();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("1199"))).toBeNull();
    });

    it("refuses anything that is not a whole number of mSIU, more than none", () => {
      const need = quoted();
      for (const bad of ["0", "-5", "1.5", "five", "", undefined, 500]) {
        expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split(bad)), String(bad)).toBe(
          "the claim part of a split is a whole number of mSIU, more than 0.",
        );
      }
    });

    it("refuses a claim part of the whole price or more, stating the price in mSIU", () => {
      const need = quoted();
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("1200"))).toBe(
        "the claim part of a split must be less than the quote's price, 1,200 mSIU: 1,200 mSIU is not.",
      );
      expect(guardLabCall(books, cfg, need.buyer, "settle_split_held", split("5000"))).toBe(
        "the claim part of a split must be less than the quote's price, 1,200 mSIU: 5,000 mSIU is not.",
      );
    });

    it("refuses a claim part worth nothing at the print, stating what it is worth and what the quote's dollars are", () => {
      const need = quoted();
      // At a print of 0.0005 USD per SIU, 1 mSIU is worth half a minor unit, which rounds down to none; the job's quote is 600.
      expect(guardLabCall(books, { printNano: 500_000n, params: DEFAULT_PARAMS }, need.buyer, "settle_split_held", split("1"))).toBe(
        "the claim part of a split must be worth more than nothing and less than the quote's price: 1 mSIU is worth 0 USDC minor units at the print, and the price is 600.",
      );
    });

    it("says nothing about which payment to use instead", () => {
      const need = quoted();
      const refusal = guardLabCall(books, cfg, need.buyer, "settle_split_held", split("5000"))!;
      expect(refusal).not.toMatch(/pay_with|instead|should|better|prefer/i);
      expect(refusal).not.toMatch(/usdc|fsiu|dollar/i);
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
      guardLabCall(books, cfg, buyer, "request_quote", req(sellerId, "1.2", "0.001")),
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

  describe("a print that moves between rounds (D41)", () => {
    const path = buildPrintPath(9, 1_437_000n, DEFAULT_PARAMS, "real-print");
    const moving = (): { b: LabBooks; c: GuardConfig } => {
      const b = new LabBooks(economy, ids, path);
      return {
        b,
        c: {
          get printNano(): bigint {
            return b.currentPrint()!;
          },
          params: DEFAULT_PARAMS,
        },
      };
    };

    it("accepts a quote request only at the print of the round in force as its rate: round 1's is refused in round 2", () => {
      const { b, c } = moving();
      const buyer = LAB_TRADERS.find((t) => b.openNeeds(t).length > 0)!;
      const need = b.openNeeds(buyer)[0];
      const round1 = printRate(path.byRound[0]);
      expect(guardLabCall(b, c, buyer, "request_quote", req(ids.traders[need.seller], "1.2", round1))).toBeNull();
      b.advanceRound();
      const buyer2 = LAB_TRADERS.find((t) => b.openNeeds(t).length > 0)!;
      const need2 = b.openNeeds(buyer2)[0];
      const round2 = printRate(path.byRound[1]);
      expect(round2).not.toBe(round1);
      expect(guardLabCall(b, c, buyer2, "request_quote", req(ids.traders[need2.seller], "1.2", round1))).toBe(`a quote's rate is the print, ${round2} USD per SIU.`);
      expect(guardLabCall(b, c, buyer2, "request_quote", req(ids.traders[need2.seller], "1.2", round2))).toBeNull();
    });

    it("holds a raw-work request to the print in force, too", () => {
      const { b, c } = moving();
      const owing = LAB_TRADERS.find((t) => economy.needs.some((n) => n.seller === t && n.round === 1))!;
      const need = economy.needs.find((n) => n.seller === owing && n.round === 1)!;
      b.requestPosted("qr-1", need.buyer, owing);
      b.quoteIssued("qr-1");
      b.paid("qr-1", "usdc");
      b.advanceRound();
      const old = printRate(path.byRound[0]);
      const now = printRate(path.byRound[1]);
      expect(guardLabCall(b, c, owing, "request_quote", req(ids.issuer, "1", old))).toBe(`a quote's rate is the print, ${now} USD per SIU.`);
      expect(guardLabCall(b, c, owing, "request_quote", req(ids.issuer, "1", now))).toBeNull();
    });

    it("states a split's limit in mSIU, which is the same at every print: the quote's price in SIU does not move", () => {
      const { b, c } = moving();
      const buyer = LAB_TRADERS.find((t) => b.openNeeds(t).length > 0)!;
      const need = b.openNeeds(buyer)[0];
      b.requestPosted("qr-1", buyer, need.seller);
      b.quoteIssued("qr-1");
      b.advanceRound();
      b.advanceRound();
      // Two rounds on, the print has moved, and the limit on the claim part is still the job's 1,200 mSIU.
      expect(path.byRound[2]).not.toBe(path.byRound[0]);
      expect(guardLabCall(b, c, buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "1200" })).toBe(
        "the claim part of a split must be less than the quote's price, 1,200 mSIU: 1,200 mSIU is not.",
      );
      expect(guardLabCall(b, c, buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "1199" })).toBeNull();
      expect(guardLabCall(b, c, buyer, "settle_split_held", { requestId: "qr-1", claimQuantityMilliSiu: "500" })).toBeNull();
    });
  });
});
