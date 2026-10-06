import { describe, expect, it } from "vitest";
import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import { QuoteBoard } from "../loop/quote-board.js";
import { labDisplayName } from "./economy.js";
import { ISSUER_SERVICE_TOOLS, issuerServiceAdapter } from "./issuer-service.js";

const ISSUER = "erc8004:0xISSUER";
const body = (seller: string): QuoteBody =>
  ({
    schema_version: "2.0", siu: "1", pattern: "fixed", model: "m", rate_usd_per_siu: "0.001437", amount_usd_max: "0.0014",
    index_version: "SIU-2026a", print_id: "p", print_hash: "0x00", seller_id: seller, expiry: "2026-10-06T12:00:00.000Z",
    settlement: [{ asset: "usdc", chain: "base-sepolia", address: "0x0", amount_max: "1400" }],
  }) as QuoteBody;
const signed = (seller: string): TouchstoneQuote => ({ ...body(seller), sig: "0xsig" }) as TouchstoneQuote;
const decide = async (prompt: string) => JSON.parse((await issuerServiceAdapter()("m", prompt, { temperature: 0, max_tokens: 1 })).text);

describe("the issuer service", () => {
  it("answers an open request for raw work", async () => {
    const board = new QuoteBoard({ reservationStep: false, displayName: labDisplayName });
    board.postRequest("ORCHESTRATOR", body(ISSUER));
    expect(await decide(board.renderFor("ISSUER-B", ISSUER))).toEqual({ tool: "issue_quote", args: { requestId: "qr-1" } });
  });

  it("releases the escrow of a quote that has been paid in dollars", async () => {
    const board = new QuoteBoard({ reservationStep: false, displayName: labDisplayName });
    const r = board.postRequest("ORCHESTRATOR", body(ISSUER));
    board.postIssuedQuote(r.requestId, signed(ISSUER));
    board.recordPaid(r.requestId, "usdc");
    expect(await decide(board.renderFor("ISSUER-B", ISSUER))).toEqual({ tool: "settle_escrow", args: { requestId: "qr-1" } });
  });

  it("answers requests before releasing escrows, one action a turn, and the rest stays on the board", async () => {
    const board = new QuoteBoard({ reservationStep: false, displayName: labDisplayName });
    const first = board.postRequest("ORCHESTRATOR", body(ISSUER));
    board.postIssuedQuote(first.requestId, signed(ISSUER));
    board.recordPaid(first.requestId, "usdc");
    board.postRequest("WORKER-CODE", body(ISSUER));
    const text = board.renderFor("ISSUER-B", ISSUER);
    expect(await decide(text)).toEqual({ tool: "issue_quote", args: { requestId: "qr-2" } });
  });

  it("does nothing about a quote paid in claims: there is no escrow, and the issuer simply holds the claim", async () => {
    const board = new QuoteBoard({ reservationStep: false, displayName: labDisplayName });
    const r = board.postRequest("ORCHESTRATOR", body(ISSUER));
    board.postIssuedQuote(r.requestId, signed(ISSUER));
    board.recordPaid(r.requestId, "fsiu");
    expect(await decide(board.renderFor("ISSUER-B", ISSUER))).toEqual({ wait: true });
  });

  it("waits when there is nothing to do, and costs nothing", async () => {
    const r = await issuerServiceAdapter()("m", "an empty prompt", { temperature: 0, max_tokens: 1 });
    expect(JSON.parse(r.text)).toEqual({ wait: true });
    expect(r.usage).toEqual({ input: 0, output: 0, cached_input: 0, reasoning: 0 });
  });

  it("needs only the two tools it uses", () => {
    expect([...ISSUER_SERVICE_TOOLS]).toEqual(["issue_quote", "settle_escrow"]);
  });
});
