import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import type { QuoteBoard } from "../loop/quote-board.js";
import { LabBooks } from "./books.js";
import { DEFAULT_PARAMS, LAB_TRADERS, buildEconomy, type TraderLabel } from "./economy.js";
import { referenceExecutor } from "./jobs.js";
import { ISSUER_SERVICE_TOOLS, issuerServiceAdapter } from "./issuer-service.js";
import { LabService, labQuoteBoard } from "./service.js";

const ISSUER = "erc8004:0xISSUER";
const economy = buildEconomy(9);
const ids = {
  traders: Object.fromEntries(LAB_TRADERS.map((t) => [t, `erc8004:0x${t.replace("-", "")}`])) as Record<TraderLabel, string>,
  issuer: ISSUER,
};
const body = (seller: string): QuoteBody =>
  ({
    schema_version: "2.0", siu: "1", pattern: "fixed", model: "m", rate_usd_per_siu: "0.001437", amount_usd_max: "0.001437",
    index_version: "SIU-2026a", print_id: "p", print_hash: "0x00", seller_id: seller, expiry: "2026-10-06T12:00:00.000Z",
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "1437" }],
  }) as QuoteBody;
const signed = (seller: string): TouchstoneQuote => ({ ...body(seller), sig: "0xsig" }) as TouchstoneQuote;
const decide = async (prompt: string) => JSON.parse((await issuerServiceAdapter()("m", prompt, { temperature: 0, max_tokens: 1 })).text);

/**
 * The lab's own board, built by the one factory a run uses (`labQuoteBoard`), over the books a run keeps: every request and quote reads as the lab writes
 * it, in SIU (D50). The first v8 walk found the issuer waiting forever on lines in the form this test used to render by hand — so the test no longer
 * renders anything by hand.
 */
const lab = (): { books: LabBooks; board: QuoteBoard } => {
  const books = new LabBooks(economy, ids);
  const svc = new LabService({ books, guard: { printNano: 1_437_000n, params: DEFAULT_PARAMS }, seed: 9, executorFor: () => referenceExecutor, tokenId: "777" });
  return { books, board: labQuoteBoard(svc) };
};
/** A unit of raw work asked for from the issuer by `buyer`, on the board and in the books, as the loop and the lab record them together. */
const ask = ({ books, board }: ReturnType<typeof lab>, seat: "ORCHESTRATOR" | "WORKER-CODE", buyer: TraderLabel): string => {
  const req = board.postRequest(seat, body(ISSUER));
  books.requestPosted(req.requestId, buyer, "ISSUER");
  return req.requestId;
};

describe("the issuer service", () => {
  it("answers an open request for raw work, as the lab's own board writes it", async () => {
    const l = lab();
    ask(l, "ORCHESTRATOR", "TRADER-1");
    const screen = l.board.renderFor("ISSUER-B", ISSUER);
    expect(screen).toContain("qr-1: a unit of raw work asked for by TRADER-1, 1 SIU of work, price 1 SIU — settle");
    expect(await decide(screen)).toEqual({ tool: "issue_quote", args: { requestId: "qr-1" } });
  });

  it("answers requests one at a time, and the rest stays on the board", async () => {
    const l = lab();
    ask(l, "ORCHESTRATOR", "TRADER-1");
    ask(l, "WORKER-CODE", "TRADER-2");
    expect(await decide(l.board.renderFor("ISSUER-B", ISSUER))).toEqual({ tool: "issue_quote", args: { requestId: "qr-1" } });
  });

  it("does nothing about a quote that has been paid, in either asset: the payment has already reached it", async () => {
    for (const asset of ["usdc", "fsiu", "split"] as const) {
      const l = lab();
      const id = ask(l, "ORCHESTRATOR", "TRADER-1");
      l.board.postIssuedQuote(id, signed(ISSUER));
      l.books.quoteIssued(id);
      l.board.recordPaid(id, asset);
      expect(await decide(l.board.renderFor("ISSUER-B", ISSUER)), asset).toEqual({ wait: true });
    }
  });

  it("waits when there is nothing to do, and costs nothing", async () => {
    const r = await issuerServiceAdapter()("m", "an empty prompt", { temperature: 0, max_tokens: 1 });
    expect(JSON.parse(r.text)).toEqual({ wait: true });
    expect(r.usage).toEqual({ input: 0, output: 0, cached_input: 0, reasoning: 0 });
  });

  it("needs only the one tool it uses: it has no escrow to release", () => {
    expect([...ISSUER_SERVICE_TOOLS]).toEqual(["issue_quote"]);
  });
});
