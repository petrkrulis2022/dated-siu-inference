import { beforeEach, describe, expect, it } from "vitest";
import { LabBooks, MAX_DELIVERY_ATTEMPTS } from "./books.js";
import { DEFAULT_PARAMS, LAB_TRADERS, buildEconomy, needsOf, type Economy, type TraderLabel } from "./economy.js";
import { buildPrintPath } from "./prints.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};

describe("LabBooks", () => {
  let economy: Economy;
  let books: LabBooks;
  beforeEach(() => {
    economy = buildEconomy(3);
    books = new LabBooks(economy, ids);
  });

  /** A buyer's first open need, and the seller of it. */
  const firstOpen = (buyer: TraderLabel) => books.openNeeds(buyer)[0];

  it("opens round 1 only: needs of later rounds are locked", () => {
    for (const n of economy.needs) {
      expect(books.needStatus(n)).toBe(n.round === 1 ? "open" : "locked");
    }
  });

  it("opens the next round when told, and says so plainly when there is none", () => {
    expect(books.advanceRound()).toBe(true);
    expect(books.round).toBe(2);
    expect(books.advanceRound()).toBe(true);
    expect(books.round).toBe(3);
    expect(books.advanceRound()).toBe(false);
    expect(books.round).toBe(3);
    for (const n of economy.needs) expect(books.needStatus(n)).toBe("open");
  });

  it("names who a seller id belongs to", () => {
    expect(books.counterpartyOf(ids.issuer)).toBe("ISSUER");
    expect(books.counterpartyOf(ids.traders["TRADER-2"])).toBe("TRADER-2");
    expect(books.counterpartyOf("erc8004:0xnobody")).toBeUndefined();
  });

  it("follows a need from open to met, one step at a time", () => {
    const buyer = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
    const need = firstOpen(buyer);
    books.requestPosted("qr-1", buyer, need.seller);
    expect(books.needStatus(need)).toBe("requested");
    books.quoteIssued("qr-1");
    expect(books.needStatus(need)).toBe("quoted");
    books.paid("qr-1", "fsiu");
    expect(books.needStatus(need)).toBe("paid");
    expect(books.owedBy(need.seller)).toHaveLength(1);
    books.attempted("qr-1", true);
    expect(books.needStatus(need)).toBe("met");
    expect(books.needsMet(buyer)).toBe(1);
    expect(books.owedBy(need.seller)).toHaveLength(0);
  });

  it("does not offer a need again while it is in flight", () => {
    const buyer = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
    const before = books.openNeeds(buyer).length;
    books.requestPosted("qr-1", buyer, firstOpen(buyer).seller);
    expect(books.openNeeds(buyer)).toHaveLength(before - 1);
  });

  it("ignores a request that matches no open need rather than inventing a sale", () => {
    const buyer: TraderLabel = "TRADER-1";
    const own = economy.skillOf[buyer];
    const self = economy.sellerOf[own];
    books.requestPosted("qr-9", buyer, self);
    expect(books.sale("qr-9")).toBeUndefined();
  });

  describe("raw work", () => {
    const pay = (trader: TraderLabel, id: string) => {
      books.requestPosted(id, trader, "ISSUER");
      books.quoteIssued(id);
      books.paid(id, "usdc");
    };

    it("credits one unit when the issuer's quote is paid, in either asset", () => {
      pay("TRADER-1", "qr-1");
      expect(books.unitsOf("TRADER-1")).toBe(1);
      books.requestPosted("qr-2", "TRADER-2", "ISSUER");
      books.paid("qr-2", "fsiu");
      expect(books.unitsOf("TRADER-2")).toBe(1);
    });

    it("credits nothing until it is paid, and only once", () => {
      books.requestPosted("qr-1", "TRADER-1", "ISSUER");
      books.quoteIssued("qr-1");
      expect(books.unitsOf("TRADER-1")).toBe(0);
      books.paid("qr-1", "usdc");
      books.paid("qr-1", "usdc");
      expect(books.unitsOf("TRADER-1")).toBe(1);
    });

    it("lets a trader buy a unit only while it owes more deliveries than it holds or has ordered", () => {
      const seller: TraderLabel = "TRADER-1";
      expect(books.mayBuyRawWork(seller)).toBe(false);
      const need = economy.needs.find((n) => n.seller === seller && n.round === 1) ?? economy.needs.find((n) => n.seller === seller)!;
      // Reach that need's round, then have it bought and paid.
      while (books.round < need.round) books.advanceRound();
      books.requestPosted("qr-1", need.buyer, seller);
      books.quoteIssued("qr-1");
      books.paid("qr-1", "usdc");
      expect(books.mayBuyRawWork(seller), "it now owes one delivery and holds no unit").toBe(true);
      books.requestPosted("qr-2", seller, "ISSUER");
      expect(books.mayBuyRawWork(seller), "ordered one already").toBe(false);
      books.paid("qr-2", "fsiu");
      expect(books.mayBuyRawWork(seller), "holds one for its one delivery").toBe(false);
    });

    it("spends the seller's unit on a delivery that passes, and keeps it on one that fails", () => {
      const need = economy.needs.find((n) => n.round === 1)!;
      books.requestPosted("qr-1", need.buyer, need.seller);
      books.quoteIssued("qr-1");
      books.paid("qr-1", "usdc");
      books.requestPosted("qr-2", need.seller, "ISSUER");
      books.paid("qr-2", "usdc");
      expect(books.unitsOf(need.seller)).toBe(1);
      books.attempted("qr-1", false);
      expect(books.unitsOf(need.seller)).toBe(1);
      expect(books.sale("qr-1")?.delivered).toBe(false);
      expect(books.sale("qr-1")?.attempts).toBe(1);
      books.attempted("qr-1", true);
      expect(books.unitsOf(need.seller)).toBe(0);
      expect(books.sale("qr-1")?.delivered).toBe(true);
    });
  });

  it("knows when every need is met", () => {
    expect(books.allNeedsMet()).toBe(false);
    for (let r = 1; r <= economy.params.rounds; r++) {
      if (r > 1) books.advanceRound();
      for (const n of economy.needs.filter((x) => x.round === r)) {
        const id = `qr-${n.id}`;
        books.requestPosted(id, n.buyer, n.seller);
        books.paid(id, "usdc");
        books.attempted(id, true);
      }
    }
    expect(books.allNeedsMet()).toBe(true);
    for (const t of LAB_TRADERS) expect(books.needsMet(t)).toBe(needsOf(economy, t).length);
  });

  it("allows three attempts at a job, no more", () => {
    expect(MAX_DELIVERY_ATTEMPTS).toBe(3);
  });

  describe("the print in each round (D41)", () => {
    const path = buildPrintPath(9, 1_437_000n, DEFAULT_PARAMS, "real-print");

    it("knows the print of every round, the one in force, and its id; none without a path", () => {
      const plain = new LabBooks(economy, ids);
      expect(plain.currentPrint()).toBeUndefined();
      expect(plain.printOfRound(1)).toBeUndefined();
      const b = new LabBooks(economy, ids, path);
      expect(b.currentPrint()).toBe(path.byRound[0]);
      expect(b.currentPrintId()).toBe("real-print");
      b.advanceRound();
      expect(b.currentPrint()).toBe(path.byRound[1]);
      expect(b.currentPrintId()).toBe("lab-scenario-round-2");
      expect(b.printOfRound(3)).toBe(path.byRound[2]);
    });

    it("prices a quote at the print of the round it was asked for in, whatever round it is paid in", () => {
      const b = new LabBooks(economy, ids, path);
      const need = economy.needs.find((n) => n.round === 1)!;
      b.requestPosted("qr-1", need.buyer, need.seller);
      b.requestPosted("qr-raw", need.buyer, "ISSUER");
      b.advanceRound();
      b.advanceRound();
      // Two rounds on, the print in force is round 3's; these quotes were asked for in round 1 and keep round 1's print.
      expect(b.currentPrint()).toBe(path.byRound[2]);
      expect(b.printForSale("qr-1")).toBe(path.byRound[0]);
      expect(b.printForSale("qr-raw")).toBe(path.byRound[0]);
      expect(b.sale("qr-1")?.round).toBe(1);
      expect(b.printForSale("qr-nope")).toBeUndefined();
    });

    it("records the round of a request made after the print has moved", () => {
      const b = new LabBooks(economy, ids, path);
      b.advanceRound();
      b.requestPosted("qr-9", "TRADER-1", "ISSUER");
      expect(b.sale("qr-9")?.round).toBe(2);
      expect(b.printForSale("qr-9")).toBe(path.byRound[1]);
    });
  });
});
