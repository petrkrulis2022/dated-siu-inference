import { beforeEach, describe, expect, it } from "vitest";
import { renderLabAction, renderLabInfo } from "./board.js";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, LAB_TRADERS, buildEconomy, type Economy, type TraderLabel } from "./economy.js";
import type { GuardConfig } from "./guards.js";
import { buildPrintPath, describeMove, printText } from "./prints.js";

const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t}`])) as Record<TraderLabel, string>,
  issuer: "erc8004:0xISSUER",
};
const cfg: GuardConfig = { printNano: 1_437_000n, params: DEFAULT_PARAMS }; // an illustrative print

describe("the lab board", () => {
  let economy: Economy;
  let books: LabBooks;
  beforeEach(() => {
    economy = buildEconomy(9);
    books = new LabBooks(economy, ids);
  });

  it("states the round, the trader's own skill, the prices and every trader's needs", () => {
    const text = renderLabInfo(books, cfg, "TRADER-2");
    expect(text).toContain("ROUND 1 OF 3");
    expect(text).toContain(`You are TRADER-2. You deliver ${economy.skillOf["TRADER-2"]} jobs, and only you can.`);
    expect(text).toContain("A job is 1 SIU, priced at 0.0017244 USD per SIU; its quote is 0.0017 USD.");
    expect(text).toContain("sold by ISSUER-B at the print, 0.001437 USD per SIU; its quote is 0.0014 USD.");
    for (const t of LAB_TRADERS) expect(text).toContain(`${t} delivers ${economy.skillOf[t]}.`);
    for (const n of economy.needs) expect(text).toContain(`${n.buyer} needs ${n.type} from ${n.seller}`);
  });

  it("marks a need open, not yet open or met as it really is", () => {
    const early = economy.needs.find((n) => n.round === 1)!;
    const late = economy.needs.find((n) => n.round === 3)!;
    let text = renderLabInfo(books, cfg, "TRADER-1");
    expect(text).toContain(`${early.buyer} needs ${early.type} from ${early.seller} (open)`);
    expect(text).toContain(`${late.buyer} needs ${late.type} from ${late.seller} (not yet open)`);
    books.requestPosted("qr-1", early.buyer, early.seller);
    books.paid("qr-1", "usdc");
    books.attempted("qr-1", true);
    text = renderLabInfo(books, cfg, "TRADER-1");
    expect(text).toContain(`${early.buyer} needs ${early.type} from ${early.seller} (met)`);
  });

  it("is the same wording for every trader, except the line naming the trader and its skill", () => {
    const strip = (t: string, me: TraderLabel) =>
      t
        .split("\n")
        .filter((l) => !l.includes(`You are ${me}.`) && !l.startsWith("YOUR RESULT"))
        .join("\n");
    const base = strip(renderLabInfo(books, cfg, "TRADER-1"), "TRADER-1");
    for (const t of LAB_TRADERS) expect(strip(renderLabInfo(books, cfg, t), t)).toBe(base);
  });

  it("is silent when there is nothing to act on, which is what lets a trader wait", () => {
    const buyerWithNothing = LAB_TRADERS.find((t) => books.openNeeds(t).length === 0 && books.owedBy(t).length === 0);
    if (buyerWithNothing) expect(renderLabAction(books, buyerWithNothing)).toBe("");
    for (const t of LAB_TRADERS) {
      const text = renderLabAction(books, t);
      expect(text === "" || text.startsWith("OPEN FOR YOU NOW")).toBe(true);
    }
  });

  it("lists the needs a trader can buy now and nothing it cannot", () => {
    const buyer = LAB_TRADERS.find((t) => books.openNeeds(t).length > 0)!;
    const text = renderLabAction(books, buyer);
    for (const n of books.openNeeds(buyer)) expect(text).toContain(`${n.id}: ${n.type} from ${n.seller} (round ${n.round})`);
    for (const n of economy.needs.filter((x) => x.buyer === buyer && x.round > 1)) expect(text).not.toContain(n.id);
  });

  it("tells a seller what it has been paid for and how much raw work it holds", () => {
    const need = economy.needs.find((n) => n.round === 1)!;
    books.requestPosted("qr-1", need.buyer, need.seller);
    books.paid("qr-1", "fsiu");
    const text = renderLabAction(books, need.seller);
    expect(text).toContain("Jobs you have been paid for and have not delivered (you hold 0 units of raw work):");
    expect(text).toContain(`qr-1: ${need.type} for ${need.buyer}`);
    expect(text).toContain("You owe 1 delivery and hold 0 units of raw work.");
    books.requestPosted("qr-2", need.seller, "ISSUER");
    books.paid("qr-2", "usdc");
    const after = renderLabAction(books, need.seller);
    expect(after).toContain("you hold 1 unit of raw work");
    expect(after).not.toContain("You owe 1 delivery");
  });

  it("never names either asset or advises, in anything it shows", () => {
    const need = economy.needs.find((n) => n.round === 1)!;
    books.requestPosted("qr-1", need.buyer, need.seller);
    books.paid("qr-1", "usdc");
    for (const t of LAB_TRADERS) {
      for (const text of [renderLabInfo(books, cfg, t), renderLabAction(books, t)]) {
        expect(text).not.toMatch(/usdc|fsiu|claim|escrow|mint|redeem|hold on|should|better|cheaper|prefer|keep |convert/i);
      }
    }
  });

  describe("the print and its moves (D41)", () => {
    const path = buildPrintPath(9, 1_437_000n, DEFAULT_PARAMS, "real-print");
    const moving = () => new LabBooks(economy, ids, path);

    it("shows only round 1's print in round 1, and says it is a scenario value that can move", () => {
      const text = renderLabInfo(moving(), { printNano: path.byRound[0], params: DEFAULT_PARAMS }, "TRADER-1");
      expect(text).toContain("THE PRINT (a scenario value used only inside this lab, not the published index; it can move at each round)");
      expect(text).toContain("  Round 1: 0.001437 USD per SIU");
      expect(text).not.toMatch(/Round 2: [0-9.]+ USD per SIU/); // a round that has not opened has no print shown (its needs are listed, as always)
      expect(text).toContain("The print in force now is round 1's.");
    });

    it("shows every round so far and how far each moved, once the rounds have opened", () => {
      const b = moving();
      b.advanceRound();
      b.advanceRound();
      const text = renderLabInfo(b, { printNano: path.byRound[2], params: DEFAULT_PARAMS }, "TRADER-1");
      expect(text).toContain(`  Round 2: ${printText(path.byRound[1])} USD per SIU (${describeMove(path.byRound[0], path.byRound[1])} on round 1)`);
      expect(text).toContain(`  Round 3: ${printText(path.byRound[2])} USD per SIU (${describeMove(path.byRound[1], path.byRound[2])} on round 2)`);
      expect(text).toMatch(/\(up 15\.0% on round 1\)|\(down 15\.0% on round 1\)/);
      expect(text).toContain("The print in force now is round 3's.");
    });

    it("states the prices at the print in force, which is round 2's after round 1", () => {
      const b = moving();
      b.advanceRound();
      const p2 = path.byRound[1];
      const text = renderLabInfo(b, { printNano: p2, params: DEFAULT_PARAMS }, "TRADER-1");
      expect(text).toContain(`sold by ISSUER-B at the print, ${printText(p2)} USD per SIU`);
    });

    it("says nothing about what a move means, or which asset to hold: facts only", () => {
      const b = moving();
      b.advanceRound();
      const text = renderLabInfo(b, { printNano: path.byRound[1], params: DEFAULT_PARAMS }, "TRADER-1");
      expect(text).not.toMatch(/\b(hedge|lock|hold|spend|prefer|should|expect|cheaper|dearer|gain)\b/i);
    });

    it("shows no print section in a lab with no print path (a test of the rest)", () => {
      expect(renderLabInfo(books, cfg, "TRADER-1")).not.toContain("THE PRINT");
    });
  });
});
