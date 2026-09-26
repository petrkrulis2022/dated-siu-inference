import type { QuoteBody, TouchstoneQuote } from "@touchstone/sdk";
import type { AgentId } from "../identity/resolve.js";

/**
 * Found live, 2026-09-25 (WP-7 P5 planning): `request_quote` is a pure local computation
 * (`buildQuoteBody`, no network) and `issue_quote` just signs whatever body it's given with the
 * caller's own key — neither tool makes one agent's request visible to the seller it names, or a
 * seller's signed response visible back to the buyer. Confirmed by reading
 * `dry-loop/three-hop-chain.ts`'s own doc comment: every scripted multi-hop scenario so far fixed
 * each hop's asset choice in TypeScript rather than letting an agent decide, "because that's
 * WP-7's finding, not this package's."
 *
 * This is the real, necessary completion of the mechanism, not a message channel: only the same
 * structured fields `request_quote`/`issue_quote` already produce ever appear here (a `QuoteBody`
 * a buyer constructed, a `TouchstoneQuote` a seller actually signed) — never free text one agent
 * writes for another to read. A request is visible only to the `sellerId` it names; an issued
 * quote is visible only to the buyer whose request it answers.
 */
export interface QuoteBoardRequest {
  requestId: string;
  buyer: AgentId;
  sellerId: string;
  body: QuoteBody;
}

export interface QuoteBoardIssuedQuote {
  requestId: string;
  quote: TouchstoneQuote;
}

export class QuoteBoard {
  #requests: QuoteBoardRequest[] = [];
  #issued: QuoteBoardIssuedQuote[] = [];
  #nextId = 1;

  /** Called by the loop right after a real `request_quote` tool call returns — never invented. */
  postRequest(buyer: AgentId, body: QuoteBody): QuoteBoardRequest {
    const request: QuoteBoardRequest = { requestId: `qr-${this.#nextId++}`, buyer, sellerId: body.seller_id, body };
    this.#requests.push(request);
    return request;
  }

  requestById(requestId: string): QuoteBoardRequest | undefined {
    return this.#requests.find((r) => r.requestId === requestId);
  }

  /** Called by the loop right after a real `issue_quote` tool call returns. */
  postIssuedQuote(requestId: string, quote: TouchstoneQuote): void {
    this.#issued.push({ requestId, quote });
  }

  /** The exact, real, seller-signed `TouchstoneQuote` for one request — what `pay` must actually
   * be called with. `pay`'s own real args schema (`tools/pay.ts`) takes the full quote object,
   * not a reconstruction; `renderFor`'s own board summary (amount/expiry/seller only) is real but
   * deliberately partial, so a model copying it by hand could never produce a quote whose fields
   * still match the seller's real signature. Resolved here the same way `issue_quote`'s own
   * requestId splice already is, in `buildToolArgs`. */
  issuedQuoteById(requestId: string): TouchstoneQuote | undefined {
    return this.#issued.find((i) => i.requestId === requestId)?.quote;
  }

  /** Open requests addressed to `sellerId` (this agent's own erc8004 id) that nothing has
   * answered yet — what a seller's own turn should see. */
  openRequestsFor(sellerId: string): QuoteBoardRequest[] {
    const answered = new Set(this.#issued.map((i) => i.requestId));
    return this.#requests.filter((r) => r.sellerId === sellerId && !answered.has(r.requestId));
  }

  /** Quotes issued in answer to a request `buyer` itself made — what a buyer's own turn should
   * see, so it can decide whether to `pay` against one. */
  issuedQuotesFor(buyer: AgentId): QuoteBoardIssuedQuote[] {
    const myRequestIds = new Set(this.#requests.filter((r) => r.buyer === buyer).map((r) => r.requestId));
    return this.#issued.filter((i) => myRequestIds.has(i.requestId));
  }

  /** Small, structured text for one agent's own turn — job/buyer/seller/amount fields only, no
   * free text one agent authored for another to read. Empty string when there's nothing to show,
   * so a turn with no open market activity doesn't carry a hollow "MARKET BOARD" header. */
  renderFor(agentId: AgentId, myErc8004Id: string): string {
    const openRequests = this.openRequestsFor(myErc8004Id);
    const myQuotes = this.issuedQuotesFor(agentId);
    if (openRequests.length === 0 && myQuotes.length === 0) return "";

    const lines: string[] = ["MARKET BOARD"];
    if (openRequests.length > 0) {
      lines.push("Open quote requests addressed to you (call issue_quote with { requestId } to answer one):");
      for (const r of openRequests) {
        lines.push(
          `  ${r.requestId}: from ${r.buyer}, ${r.body.siu} SIU, model ${r.body.model}, ` +
            `rate ${r.body.rate_usd_per_siu} USD/SIU, pattern ${r.body.pattern}`,
        );
      }
    }
    if (myQuotes.length > 0) {
      lines.push("Quotes you have received (pay against one with the real quote object, via get_balances/pay):");
      for (const i of myQuotes) {
        lines.push(
          `  answers ${i.requestId}: seller ${i.quote.seller_id}, amount_usd_max ${i.quote.amount_usd_max}, ` +
            `expires ${i.quote.expiry}`,
        );
      }
    }
    return lines.join("\n");
  }
}
